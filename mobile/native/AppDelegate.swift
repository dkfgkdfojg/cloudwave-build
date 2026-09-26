import AVFoundation
import Capacitor
import MediaPlayer
import UIKit
import WebKit

// Заменяет AppDelegate.swift, который генерирует `cap add ios` на CI. Всё нативное лежит
// в этом файле, потому что новые файлы пришлось бы отдельно регистрировать в .xcodeproj.

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Без категории playback iOS глушит звук WKWebView при блокировке экрана.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        // Без этого MPRemoteCommandCenter молчит: iOS не шлёт события даже зарегистрированным
        // командам и на экране блокировки остаются дефолтные ±10 секунд вместо next/prev/like.
        application.beginReceivingRemoteControlEvents()
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

// SceneDelegate.swift на CI переключается на этот класс, чтобы зарегистрировать плагин входа
// (приложение стартует через сцены, а не через Main.storyboard).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SoundCloudLoginPlugin())
        bridge?.registerPluginInstance(NowPlayingPlugin())
        bridge?.registerPluginInstance(ChunkLoaderPlugin())
    }
}

// Звук играет AVPlayer, а не <audio> в WKWebView. Пока играл <audio>, экран блокировки и
// Dynamic Island принадлежали WebKit: он показывал свои ±10 секунд без обложки и перекрывал
// и navigator.mediaSession, и MPRemoteCommandCenter (оба пробовали, 16.09 и 21.09).
// В фоне WebView засыпает, поэтому следующий трек JS отдаёт заранее (preloadNext),
// и переход на него, пауза и перемотка с экрана блокировки работают без JS.
// Ключи FairPlay для DRM-треков SoundCloud — так же, как их веб-плеер: сертификат GET /playback/fairplay,
// лицензия POST туда же с license_token и телом spc=…&assetId=… (assetId — skd:// без схемы).
final class FairPlayKeys: NSObject, AVContentKeySessionDelegate {
    private static let licenseUrl = URL(string: "https://license.media-streaming.soundcloud.cloud/playback/fairplay")!
    private static var certificate: Data?

    private let token: String
    private let session = AVContentKeySession(keySystem: .fairPlayStreaming)

    init(token: String, asset: AVURLAsset) {
        self.token = token
        super.init()
        session.setDelegate(self, queue: DispatchQueue(label: "cloudwave.fairplay"))
        session.addContentKeyRecipient(asset)
    }

    func contentKeySession(_ session: AVContentKeySession, didProvide keyRequest: AVContentKeyRequest) {
        handle(keyRequest)
    }

    func contentKeySession(_ session: AVContentKeySession, didProvideRenewingContentKeyRequest keyRequest: AVContentKeyRequest) {
        handle(keyRequest)
    }

    private func handle(_ keyRequest: AVContentKeyRequest) {
        guard let skd = keyRequest.identifier as? String, skd.hasPrefix("skd://") else { return }
        let assetId = String(skd.dropFirst("skd://".count))
        Task {
            do {
                let certificate = try await certificate()
                let spc = try await keyRequest.makeStreamingContentKeyRequestData(forApp: certificate, contentIdentifier: Data(assetId.utf8))
                let ckc = try await license(spc: spc, assetId: assetId)
                keyRequest.processContentKeyResponse(AVContentKeyResponse(fairPlayStreamingKeyResponseData: ckc))
            } catch {
                NSLog("[FairPlay] %@", String(describing: error))
                keyRequest.processContentKeyResponseError(error)
            }
        }
    }

    private func withToken(_ url: URL) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "license_token", value: token)]
        return parts.url!
    }

    // Веб-плеер берёт сертификат без токена; на случай, если сервер начнёт его требовать, пробуем и с ним.
    private func certificate() async throws -> Data {
        if let cached = Self.certificate { return cached }
        for url in [Self.licenseUrl, withToken(Self.licenseUrl)] {
            let (data, response) = try await URLSession.shared.data(from: url)
            if (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty {
                Self.certificate = data
                return data
            }
        }
        throw FairPlayError("сертификат FairPlay не получен")
    }

    private func license(spc: Data, assetId: String) async throws -> Data {
        var request = URLRequest(url: withToken(Self.licenseUrl))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("spc=\(spc.base64EncodedString())&assetId=\(assetId)".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw FairPlayError("лицензия FairPlay: HTTP \(status) \(String(decoding: data.prefix(200), as: UTF8.self))")
        }
        // В каком виде приходит CKC, по веб-плееру не видно: бывает base64-текстом, бывает JSON с ckc.
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let text = json["ckc"] as? String ?? json["license"] as? String,
           let ckc = Data(base64Encoded: text) {
            return ckc
        }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(base64Encoded: text) ?? data
    }
}

struct FairPlayError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@objc(NowPlayingPlugin)
class NowPlayingPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NowPlayingPlugin"
    let jsName = "NowPlaying"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preloadNext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
    ]

    private let player = AVPlayer()
    private var statusObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    // AVPlayer требует держать токен периодического наблюдателя, пока нужны его вызовы.
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var sleepWork: DispatchWorkItem?
    private var pendingSeek: Double?
    private var meta: [String: Any] = [:]
    private var upcoming: (path: String, meta: [String: Any])?
    // DRM-треки открываются ссылкой на HLS; токен лицензии к ней и ключи текущего трека.
    private var licenseTokens: [String: String] = [:]
    private var fairPlay: FairPlayKeys?
    private var artwork: [String: UIImage] = [:]
    // Играть ли по воле слушателя — в отличие от пауз, которые ставит сама система (звонок, наушники).
    private var playIntent = false
    private var sessionObservers: [NSObjectProtocol] = []

    override public func load() {
        let center = MPRemoteCommandCenter.shared()
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        center.seekForwardCommand.isEnabled = false
        center.seekBackwardCommand.isEnabled = false

        // После запуска очередь восстановлена, но трек ещё не открыт: «play» с экрана блокировки или
        // AirPods раньше уходил в пустой плеер и ничего не делал — открыть трек может только JS.
        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.player.currentItem == nil { self.send("play") } else { self.startPlaying() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in self?.stopPlaying(); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.player.currentItem == nil {
                self.send("playpause")
            } else if self.player.timeControlStatus == .paused {
                self.startPlaying()
            } else {
                self.stopPlaying()
            }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.advance()
            self?.send("next")
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.send("previous"); return .success }
        center.likeCommand.addTarget { [weak self] _ in self?.send("like"); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.seek(to: event.positionTime)
            return .success
        }
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.nextTrackCommand,
                        center.previousTrackCommand, center.likeCommand, center.changePlaybackPositionCommand] {
            command.isEnabled = true
        }

        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                self?.emit(["type": "state", "playing": player.timeControlStatus != .paused])
                self?.refreshInfo()
            }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            self?.emit(["type": "time", "time": time.seconds])
        }

        let session = AVAudioSession.sharedInstance()
        // Звонок, Siri, будильник ставят звук на паузу. Когда они закончились и iOS разрешает продолжить
        // (.shouldResume), продолжаем — раньше музыка после звонка так и оставалась на паузе.
        sessionObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            guard let self, self.playIntent,
                  let rawType = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: rawType) == .ended,
                  let rawOptions = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
                  AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            self.player.play()
        })
        // Выдернули наушники — AVPlayer сам встаёт на паузу, и после ближайшего звонка включать его не надо.
        sessionObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
            guard let rawReason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable else { return }
            self?.playIntent = false
        })
    }

    private func startPlaying() {
        playIntent = true
        player.play()
    }

    private func stopPlaying() {
        playIntent = false
        player.pause()
    }

    // Склеенный из HLS-сегментов .m4a бывает без длительности в заголовке (0 или NaN) — тогда берём длину
    // трека из метаданных. NaN Capacitor вообще не пересылает, и на телефоне не работали полоса и перемотка.
    private func duration(of item: AVPlayerItem) -> Double {
        let seconds = item.duration.seconds
        return seconds.isFinite && seconds > 0 ? seconds : meta["length"] as? Double ?? 0
    }

    private func send(_ action: String, value: Double? = nil) {
        var data: [String: Any] = ["action": action]
        if let value { data["value"] = value }
        notifyListeners("command", data: data)
    }

    private func emit(_ data: [String: Any]) {
        notifyListeners("player", data: data)
    }

    private static func meta(from call: CAPPluginCall) -> [String: Any] {
        [
            "title": call.getString("title") ?? "",
            "artist": call.getString("artist") ?? "",
            "album": call.getString("album") ?? "",
            "artUrl": call.getString("artUrl") ?? "",
            "length": call.getDouble("length") ?? 0,
        ]
    }

    private func open(_ path: String, autoplay: Bool, startAt: Double = 0) {
        try? AVAudioSession.sharedInstance().setActive(true)
        let item = playerItem(for: path)
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.advance()
            self.emit(["type": "ended"])
        }
        itemObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, item === self.player.currentItem else { return }
                if item.status == .readyToPlay {
                    self.emit(["type": "duration", "duration": self.duration(of: item)])
                    if let seek = self.pendingSeek {
                        self.pendingSeek = nil
                        self.seek(to: seek)
                    }
                    self.refreshInfo()
                } else if item.status == .failed {
                    self.emit(["type": "error", "message": item.error?.localizedDescription ?? "файл не открылся"])
                }
            }
        }
        upcoming = nil
        pendingSeek = startAt > 0 ? startAt : nil
        player.replaceCurrentItem(with: item)
        if autoplay { startPlaying() }
        refreshInfo()
    }

    private func playerItem(for path: String) -> AVPlayerItem {
        guard path.hasPrefix("https://"), let token = licenseTokens[path], let url = URL(string: path) else {
            fairPlay = nil
            return AVPlayerItem(url: URL(fileURLWithPath: path))
        }
        licenseTokens = licenseTokens.filter { $0.key == path }
        let asset = AVURLAsset(url: url)
        fairPlay = FairPlayKeys(token: token, asset: asset)
        return AVPlayerItem(asset: asset)
    }

    // Переход на заранее скачанный следующий трек — без JS, который в фоне спит. Если файл уже убрала
    // чистка кэша, не открываем пустышку с ошибкой, а оставляем переход JS.
    private func advance() {
        guard let next = upcoming, next.path.hasPrefix("https://") || FileManager.default.fileExists(atPath: next.path) else { return }
        meta = next.meta
        emit(["type": "advanced", "path": next.path])
        open(next.path, autoplay: true)
    }

    private func seek(to time: Double) {
        guard player.currentItem?.status == .readyToPlay else {
            pendingSeek = time
            return
        }
        player.seek(to: CMTime(seconds: time, preferredTimescale: 600)) { [weak self] _ in
            DispatchQueue.main.async {
                self?.emit(["type": "seeked", "time": time])
                self?.refreshInfo()
            }
        }
    }

    private func refreshInfo() {
        guard let item = player.currentItem else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: meta["title"] as? String ?? "",
            MPMediaItemPropertyArtist: meta["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: meta["album"] as? String ?? "",
            MPMediaItemPropertyPlaybackDuration: duration(of: item),
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds,
            MPNowPlayingInfoPropertyPlaybackRate: player.timeControlStatus == .paused ? 0.0 : 1.0,
        ]
        if let url = meta["artUrl"] as? String, !url.isEmpty {
            if let image = artwork[url] {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            } else {
                loadArtwork(url)
            }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                if self.artwork.count > 8 { self.artwork.removeAll() }
                self.artwork[urlString] = image
                self.refreshInfo()
            }
        }.resume()
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { return call.reject("нужен path") }
        let autoplay = call.getBool("autoplay", false)
        let startAt = call.getDouble("startAt") ?? 0
        let token = call.getString("licenseToken")
        DispatchQueue.main.async {
            if let token { self.licenseTokens[path] = token }
            self.open(path, autoplay: autoplay, startAt: startAt)
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.startPlaying()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopPlaying()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let time = call.getDouble("time") ?? 0
        DispatchQueue.main.async {
            self.seek(to: time)
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = Float(call.getDouble("volume") ?? 1)
        let muted = call.getBool("muted", false)
        DispatchQueue.main.async {
            self.player.volume = volume
            self.player.isMuted = muted
            call.resolve()
        }
    }

    // Пустой путь — следующего трека нет, его убрали из очереди или он ещё качается: тогда плеер
    // в конце трека сам никуда не переходит, а не включает устаревший «следующий».
    @objc func preloadNext(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let meta = Self.meta(from: call)
        let token = call.getString("licenseToken")
        DispatchQueue.main.async {
            if let token { self.licenseTokens[path] = token }
            self.upcoming = path.isEmpty ? nil : (path, meta)
            if !path.isEmpty, let url = meta["artUrl"] as? String, self.artwork[url] == nil { self.loadArtwork(url) }
            call.resolve()
        }
    }

    // Таймер сна живёт здесь: при заблокированном экране JS в WKWebView спит и его setTimeout
    // не срабатывает, а приложение с играющим AVPlayer работает дальше. 0 — выключить.
    @objc func setSleepTimer(_ call: CAPPluginCall) {
        let seconds = call.getDouble("seconds") ?? 0
        DispatchQueue.main.async {
            self.sleepWork?.cancel()
            self.sleepWork = nil
            if seconds > 0 {
                let work = DispatchWorkItem { [weak self] in
                    self?.stopPlaying()
                    self?.sleepWork = nil
                }
                self.sleepWork = work
                DispatchQueue.main.asyncAfter(wallDeadline: .now() + seconds, execute: work)
            }
            call.resolve()
        }
    }

    // Из WKWebView файл не скачать (нет WKDownloadDelegate), а в буфер обмена после сетевых запросов
    // WebKit уже не пишет — отдаём файл системному листу «Поделиться» («Сохранить в Файлы», AirDrop).
    @objc func shareFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"),
              let data = call.getString("base64").flatMap({ Data(base64Encoded: $0) }) ?? call.getString("text")?.data(using: .utf8) else {
            return call.reject("нужны name и text или base64")
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent((name as NSString).lastPathComponent)
        do {
            try data.write(to: file, options: .atomic)
        } catch {
            return call.reject("файл не записался: \(error.localizedDescription)")
        }
        DispatchQueue.main.async {
            guard var presenter = self.bridge?.viewController else { return call.reject("некуда показать лист") }
            while let shown = presenter.presentedViewController { presenter = shown }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            // На iPad лист всплывает поповером — ему нужна точка привязки.
            sheet.popoverPresentationController?.sourceView = presenter.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                call.resolve(["completed": completed])
            }
            presenter.present(sheet, animated: true)
        }
    }

    // Метаданные текущего трека из JS; время и состояние берём у самого плеера.
    @objc func update(_ call: CAPPluginCall) {
        let meta = Self.meta(from: call)
        let liked = call.getBool("liked", false)
        DispatchQueue.main.async {
            self.meta = meta
            MPRemoteCommandCenter.shared().likeCommand.isActive = liked
            self.refreshInfo()
            call.resolve()
        }
    }

    // Вибрацию из WKWebView не вызвать: navigator.vibrate в iOS нет.
    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        call.resolve()
    }

    // Иконки лежат в Assets.xcassets, их имена передаются xcodebuild через
    // ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES (см. ios.yml).
    @objc func setIcon(_ call: CAPPluginCall) {
        let name = call.getString("name")
        DispatchQueue.main.async {
            guard UIApplication.shared.supportsAlternateIcons else { return call.reject("iOS не даёт сменить иконку") }
            UIApplication.shared.setAlternateIconName(name == "default" ? nil : name) { error in
                if let error { call.reject(error.localizedDescription) } else { call.resolve() }
            }
        }
    }
}

// Из РФ без VPN CDN SoundCloud отдаёт на одно TCP-соединение около 16 КБ, дальше тишина
// (ТСПУ, проверено 21.09.2026). Поэтому файл качаем кусками меньше порога, каждый кусок
// по своему соединению, и играем уже из локального файла. Отдельная URLSession на кусок
// обязательна: общая сессия пустила бы все запросы в одно HTTP/2-соединение.
@objc(ChunkLoaderPlugin)
class ChunkLoaderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ChunkLoaderPlugin"
    let jsName = "ChunkLoader"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drop", returnType: CAPPluginReturnPromise),
    ]

    private static let chunkSize = 14_000
    private static let parallel = 16
    private static let keepFiles = 12

    private lazy var folder: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("stream")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // Офлайн-копии: кэш потока iOS может вычистить, Documents — нет.
    private lazy var offline: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("offline")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // move — перенести из кэша потока, а не скопировать. Копии забивали кэш при «Скачать всё», и его чистка
    // удаляла файлы, которые плеер играл или вот-вот начнёт играть. Их JS как раз просит скопировать.
    @objc func keep(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let name = call.getString("name") else { return call.reject("нужны path и name") }
        let move = call.getBool("move", false)
        let target = offline.appendingPathComponent(name)
        do {
            try? FileManager.default.removeItem(at: target)
            if move {
                try FileManager.default.moveItem(at: URL(fileURLWithPath: path), to: target)
            } else {
                try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: target)
            }
            let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            call.resolve(["path": target.path, "size": size])
        } catch {
            call.reject("не сохранился: \(error.localizedDescription)")
        }
    }

    @objc func locate(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { return call.reject("нужен name") }
        let target = offline.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: target.path) { call.resolve(["path": target.path]) } else { call.reject("нет файла") }
    }

    @objc func drop(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { return call.reject("нужен name") }
        try? FileManager.default.removeItem(at: offline.appendingPathComponent(name))
        call.resolve()
    }

    // urls склеиваются по порядку в один файл: так собирается и mp3, и HLS (init + сегменты).
    @objc func fetch(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let urls = call.getArray("urls", String.self)?.compactMap(URL.init(string:)), !urls.isEmpty else {
            return call.reject("нужны name и urls")
        }
        let file = folder.appendingPathComponent(name)
        if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 {
            return call.resolve(["path": file.path])
        }
        Task {
            do {
                var data = Data()
                for url in urls { data.append(try await Self.download(url)) }
                try data.write(to: file, options: .atomic)
                self.prune()
                call.resolve(["path": file.path])
            } catch {
                call.reject("не скачался: \(error.localizedDescription)")
            }
        }
    }

    // Когда сеть не режет (VPN, другой провайдер), куски только тратят батарею: ~130 TLS-рукопожатий
    // на трек. Поэтому сначала обычная загрузка; встала на лимите — 10 минут качаем кусками сразу.
    private static var throttledUntil = Date.distantPast

    private static func download(_ url: URL) async throws -> Data {
        if Date() > throttledUntil {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 4
            let session = URLSession(configuration: config)
            defer { session.finishTasksAndInvalidate() }
            if let (data, response) = try? await session.data(from: url), (response as? HTTPURLResponse)?.statusCode == 200 {
                return data
            }
            throttledUntil = Date().addingTimeInterval(600)
        }
        return try await chunked(url)
    }

    private static func chunked(_ url: URL) async throws -> Data {
        let (first, total) = try await chunk(url, from: 0)
        guard let total, total > first.count else { return first }
        let starts = Array(stride(from: first.count, to: total, by: chunkSize))
        let parts = try await withThrowingTaskGroup(of: (Int, Data).self, returning: [Int: Data].self) { group in
            var pending = starts[...]
            var collected = [Int: Data]()
            for _ in 0..<parallel {
                guard let start = pending.popFirst() else { break }
                group.addTask { (start, try await Self.chunkWithRetry(url, from: start, total: total)) }
            }
            while let (start, data) = try await group.next() {
                collected[start] = data
                if let start = pending.popFirst() {
                    group.addTask { (start, try await Self.chunkWithRetry(url, from: start, total: total)) }
                }
            }
            return collected
        }
        return starts.reduce(into: first) { result, start in result.append(parts[start]!) }
    }

    private static func chunkWithRetry(_ url: URL, from start: Int, total: Int) async throws -> Data {
        let expected = min(chunkSize, total - start)
        var lastError: Error = URLError(.cannotLoadFromNetwork)
        for _ in 0..<5 {
            do {
                let (data, _) = try await chunk(url, from: start)
                if data.count == expected { return data }
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    // Возвращает кусок и полный размер файла из Content-Range (nil, если сервер отдал файл целиком).
    private static func chunk(_ url: URL, from start: Int) async throws -> (Data, Int?) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("bytes=\(start)-\(start + chunkSize - 1)", forHTTPHeaderField: "Range")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, [200, 206].contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let total = (http.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last).flatMap { Int($0) }
        return (data, http.statusCode == 206 ? total : nil)
    }

    private func prune() {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(Self.keepFiles) {
            try? FileManager.default.removeItem(at: file)
        }
    }
}

// Открывает soundcloud.com/signin в листе и забирает куку oauth_token, как окно входа в Electron.
// @objc(...) обязателен: без него Capacitor не увидел плагин в PluginHeaders и JS кидал
// «"SoundCloudLogin" plugin is not implemented on ios», хотя registerPluginInstance() отрабатывал.
@objc(SoundCloudLoginPlugin)
class SoundCloudLoginPlugin: CAPPlugin, CAPBridgedPlugin, UIAdaptivePresentationControllerDelegate, WKUIDelegate, WKNavigationDelegate {
    let identifier = "SoundCloudLoginPlugin"
    let jsName = "SoundCloudLogin"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
    ]

    // У WKWebView в UA нет «Safari/…», и страница входа Google его отвергает. UA десктопный: с мобильным
    // soundcloud.com уводит вход на m.soundcloud.com, а куку oauth_token мы проверяли только в десктопном входе (Electron).
    private static let safariUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"

    private var pendingCall: CAPPluginCall?
    private var sheet: UINavigationController?
    private var poll: Timer?
    // Вход на телефоне не проходит, а отладчика нет: лист пишет навигацию и имена кук прямо на экран.
    private var logView: UITextView?
    private var lastCookieNames = ""

    private func log(_ line: String) {
        guard let logView else { return }
        logView.text += line + "\n"
        logView.scrollRangeToVisible(NSRange(location: logView.text.utf16.count, length: 0))
    }

    @objc func login(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
            web.customUserAgent = Self.safariUserAgent
            web.uiDelegate = self
            web.navigationDelegate = self

            let logView = UITextView()
            logView.isEditable = false
            logView.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
            logView.heightAnchor.constraint(equalToConstant: 140).isActive = true
            self.logView = logView
            self.lastCookieNames = ""

            let page = UIViewController()
            let stack = UIStackView(arrangedSubviews: [web, logView])
            stack.axis = .vertical
            stack.backgroundColor = .systemBackground
            page.view = stack
            page.title = "Вход в SoundCloud"
            page.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
                self?.finish(token: nil)
            })
            page.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Копировать лог", primaryAction: UIAction { _ in
                UIPasteboard.general.string = logView.text
            })
            self.log("load https://soundcloud.com/signin")
            web.load(URLRequest(url: URL(string: "https://soundcloud.com/signin")!))

            let sheet = UINavigationController(rootViewController: page)
            sheet.presentationController?.delegate = self
            self.sheet = sheet
            self.pendingCall = call
            self.bridge?.viewController?.present(sheet, animated: true)

            self.poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                    let names = cookies.filter { $0.domain.contains("soundcloud.com") }.map(\.name).sorted().joined(separator: ",")
                    if names != self?.lastCookieNames {
                        self?.lastCookieNames = names
                        self?.log("cookies: \(names)")
                    }
                    if let token = cookies.first(where: { $0.name == "oauth_token" })?.value {
                        self?.finish(token: token)
                    }
                }
            }
        }
    }

    @objc func logout(_ call: CAPPluginCall) {
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.domain.contains("soundcloud.com") {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default()
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            store.fetchDataRecords(ofTypes: types) { records in
                let soundcloud = records.filter { $0.displayName.contains("soundcloud") }
                store.removeData(ofTypes: types, for: soundcloud) {
                    call.resolve()
                }
            }
        }
    }

    // Google, Apple и Facebook открывают вход через window.open. Без uiDelegate WKWebView такое окно молча
    // отбрасывает, и кнопки просто не реагируют. Отдаём окно, созданное с той же конфигурацией: у него общее
    // хранилище кук и связь с opener, через которую Google возвращает результат.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.customUserAgent = Self.safariUserAgent
        popup.uiDelegate = self
        popup.navigationDelegate = self
        log("popup \(navigationAction.request.url?.absoluteString ?? "")")
        let page = UIViewController()
        page.view = popup
        sheet?.pushViewController(page, animated: true)
        return popup
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        log("commit \(webView.url?.absoluteString ?? "")")
    }

    // Новый вход через secure.soundcloud.com может хранить токен не в куке, поэтому смотрим и ключи localStorage.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("Object.keys(localStorage).join(',')") { [weak self] keys, _ in
            self?.log("finish \(webView.url?.host ?? ""), localStorage: \((keys as? String) ?? "-")")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("fail \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("fail provisional \(error.localizedDescription)")
    }

    func webViewDidClose(_ webView: WKWebView) {
        sheet?.popViewController(animated: true)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(token: nil)
    }

    private func finish(token: String?) {
        poll?.invalidate()
        poll = nil
        sheet?.dismiss(animated: true)
        sheet = nil
        logView = nil
        guard let call = pendingCall else { return }
        pendingCall = nil
        guard let token else {
            call.resolve([:])
            return
        }
        // Лайки SoundCloud закрывает DataDome. CapacitorHttp ходит через HTTPCookieStorage,
        // куда куки из листа входа (в том числе datadome) сами не попадают.
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            for cookie in cookies where cookie.domain.contains("soundcloud.com") {
                HTTPCookieStorage.shared.setCookie(cookie)
            }
            call.resolve(["token": token])
        }
    }
}
