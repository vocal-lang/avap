import Capacitor
import UIKit
import WebKit

/// `CAPBridgeViewController` uses the WKWebView as the root `view`. Do not add subviews to the
/// web view (covers, etc.) — that breaks compositing and causes white/blank screens after resume.
final class MainViewController: CAPBridgeViewController {
    private static let appBackground = UIColor(red: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
    private static let entryPath = "/"

    private static func makeHomeURL(from webView: WKWebView) -> URL {
        if let current = webView.url,
           var comps = URLComponents(url: current, resolvingAgainstBaseURL: false) {
            comps.path = Self.entryPath
            comps.query = nil
            comps.fragment = nil
            if let url = comps.url { return url }
        }
        return URL(string: "capacitor://localhost\(Self.entryPath)")!
    }

    private static func loadHome(in webView: WKWebView) {
        webView.stopLoading()
        let url = makeHomeURL(from: webView)
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    private static func shouldApplyAppStoreIphoneOverrides() -> Bool {
#if DEBUG
        return false
#else
        return UIDevice.current.userInterfaceIdiom == .phone
#endif
    }

    private static func makeAppleMapsURL(fromGoogleMapsURL url: URL) -> URL? {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let query = comps.queryItems?.first(where: { $0.name == "query" })?.value
        guard let query, !query.isEmpty else { return nil }
        var apple = URLComponents(string: "https://maps.apple.com/")!
        apple.queryItems = [URLQueryItem(name: "q", value: query)]
        return apple.url
    }

    private static func makeWeatherURL() -> URL {
        return URL(string: "https://weather.apple.com/")!
    }

    private static func isSafetyExitURL(_ url: URL) -> Bool {
        guard url.scheme == "https" || url.scheme == "http" else { return false }
        guard url.host == "www.google.com" || url.host == "google.com" else { return false }
        let path = url.path.isEmpty ? "/" : url.path
        return path == "/" && url.query == nil && url.fragment == nil
    }

    private var pendingForceRecovery = false

    private final class NavigationDelegateProxy: NSObject, WKNavigationDelegate {
        weak var primary: WKNavigationDelegate?
        weak var secondary: WKNavigationDelegate?

        init(primary: WKNavigationDelegate?, secondary: WKNavigationDelegate?) {
            self.primary = primary
            self.secondary = secondary
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            primary?.webViewWebContentProcessDidTerminate?(webView)
            secondary?.webViewWebContentProcessDidTerminate?(webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            primary?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
            secondary?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            primary?.webView?(webView, didFinish: navigation)
            secondary?.webView?(webView, didFinish: navigation)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            primary?.webView?(webView, didFail: navigation, withError: error)
            secondary?.webView?(webView, didFail: navigation, withError: error)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url {
                let scheme = (url.scheme ?? "").lowercased()
                if scheme == "https" || scheme == "http" {
                    let host = (url.host ?? "").lowercased()
                    // WKWebView loads maps.apple.com in-web unless we hand off to the system (Debug + Release).
                    if host == "maps.apple.com" {
                        UIApplication.shared.open(url, options: [:], completionHandler: nil)
                        decisionHandler(.cancel)
                        return
                    }
                    // Google Maps search → Apple Maps (all iOS builds; previously only non-Debug iPhone).
                    if (host == "www.google.com" || host == "google.com"),
                       url.path.hasPrefix("/maps"),
                       let appleMaps = MainViewController.makeAppleMapsURL(fromGoogleMapsURL: url) {
                        UIApplication.shared.open(appleMaps, options: [:], completionHandler: nil)
                        decisionHandler(.cancel)
                        return
                    }
                }

                if MainViewController.shouldApplyAppStoreIphoneOverrides() {
                    // Safety Exit: web uses google.com; in App Store iPhone build, open Weather app instead.
                    if MainViewController.isSafetyExitURL(url) {
                        UIApplication.shared.open(MainViewController.makeWeatherURL(), options: [:], completionHandler: nil)
                        decisionHandler(.cancel)
                        return
                    }
                }
            }

            if let primary = primary, primary.responds(to: #selector(webView(_:decidePolicyFor:decisionHandler:))) {
                primary.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
                return
            }
            decisionHandler(.allow)
        }
    }

    private final class RecoveryDelegate: NSObject, WKNavigationDelegate {
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            MainViewController.loadHome(in: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            MainViewController.loadHome(in: webView)
        }
    }

    private lazy var recoveryDelegate = RecoveryDelegate()
    private var navigationProxy: NavigationDelegateProxy?

    private var lifecycleObservers: [NSObjectProtocol] = []
    private var shouldReloadWebViewAfterBackground = false
    private var resumeReloadWorkItem: DispatchWorkItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        installNavigationProxy()
        applyWebViewChrome()
        view.backgroundColor = Self.appBackground

        let bg = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.shouldReloadWebViewAfterBackground = true
        }

        let active = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reloadWebViewIfReturnedFromBackground()
        }

        lifecycleObservers = [bg, active]
    }

    deinit {
        lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) }
        resumeReloadWorkItem?.cancel()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installNavigationProxy()
        applyWebViewChrome()
        if pendingForceRecovery {
            forceRecoverToHome()
        }
    }

    func forceRecoverToHome() {
        guard let webView = bridge?.webView else {
            pendingForceRecovery = true
            return
        }
        pendingForceRecovery = false
        Self.loadHome(in: webView)
    }

    private func reloadWebViewIfReturnedFromBackground() {
        guard shouldReloadWebViewAfterBackground else { return }
        shouldReloadWebViewAfterBackground = false

        guard let webView = bridge?.webView else { return }

        resumeReloadWorkItem?.cancel()
        let work = DispatchWorkItem { [weak webView] in
            guard let webView else { return }
            webView.stopLoading()
            webView.reload()
        }
        resumeReloadWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    private func installNavigationProxy() {
        guard let webView = bridge?.webView else { return }
        if webView.navigationDelegate === navigationProxy { return }
        navigationProxy = NavigationDelegateProxy(primary: webView.navigationDelegate, secondary: recoveryDelegate)
        webView.navigationDelegate = navigationProxy
    }

    private func applyWebViewChrome() {
        guard let webView = bridge?.webView else { return }
        webView.backgroundColor = Self.appBackground
        webView.scrollView.backgroundColor = Self.appBackground
    }
}
