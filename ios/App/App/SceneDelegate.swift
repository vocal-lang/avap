import UIKit

/// UIScene lifecycle (required going forward). Owns the key `UIWindow` for Capacitor.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let bg = UIColor(red: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = bg
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window?.rootViewController = storyboard.instantiateInitialViewController()
        window?.makeKeyAndVisible()
    }
}
