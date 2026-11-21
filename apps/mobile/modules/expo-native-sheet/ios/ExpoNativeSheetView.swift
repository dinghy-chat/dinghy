import ExpoModulesCore
import UIKit

// The content of a React Native page sheet. It finds the sheet controller that presents it and
// gives that sheet one detent as tall as the content, so UIKit runs the presentation, the drag to
// close, the move above the keyboard and Reduce Motion as it does for a system sheet.
final class ExpoNativeSheetView: ExpoView {
  let onSheetLayout = EventDispatcher()
  let onKeyboardInset = EventDispatcher()
  let onWindow = EventDispatcher()

  private static let detent = UISheetPresentationController.Detent.Identifier("chat.dinghy.content")

  private weak var controller: UIViewController?
  private var fittedHeight: CGFloat = 0
  private var reportedMaximum: CGFloat = 0
  private var reportedKeyboardHeight: CGFloat = 0
  private var keyboardFrame = CGRect.null
  private var style = UIUserInterfaceStyle.unspecified

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(keyboardWillChange(_:)),
      name: UIResponder.keyboardWillChangeFrameNotification, object: nil
    )
    center.addObserver(
      self, selector: #selector(keyboardDidChange(_:)),
      name: UIResponder.keyboardDidChangeFrameNotification, object: nil
    )
  }

  // React Native mounts the whole sheet before it presents it, and the sheet's view joins a window
  // as UIKit lays out the presentation. Setting the detent here still lands before the first frame.
  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow != nil {
      attach()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      attach()
    }
    // The sheet leaves the screen once it closes, or while a full screen covers it.
    if controller != nil {
      onWindow(["attached": window != nil])
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    attach()
    guard bounds.height != fittedHeight else { return }
    fittedHeight = bounds.height
    refit()
  }

  /** Follows the app's own light or dark setting, so the grabber and the dimming match it. */
  func setDark(_ dark: Bool) {
    style = dark ? .dark : .light
    controller?.overrideUserInterfaceStyle = style
  }

  private func attach() {
    guard let found = presentingSheetController(), found !== controller,
      let sheet = found.sheetPresentationController
    else { return }
    controller = found
    found.overrideUserInterfaceStyle = style
    fittedHeight = bounds.height
    sheet.detents = [
      .custom(identifier: Self.detent) { [weak self] context in
        self?.resolve(context) ?? context.maximumDetentValue
      }
    ]
    sheet.selectedDetentIdentifier = Self.detent
    sheet.prefersGrabberVisible = true
    sheet.prefersScrollingExpandsWhenScrolledToEdge = false
  }

  /** The modal view controller this view sits in, when UIKit shows it as a sheet. */
  private func presentingSheetController() -> UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let found = current as? UIViewController {
        let style = found.modalPresentationStyle
        return style == .pageSheet || style == .formSheet ? found : nil
      }
      responder = current.next
    }
    return nil
  }

  // UIKit measures a custom detent above the bottom safe area, as tall as the content here.
  private func resolve(_ context: UISheetPresentationControllerDetentResolutionContext) -> CGFloat {
    let maximum = context.maximumDetentValue
    if maximum != reportedMaximum {
      reportedMaximum = maximum
      // The resolver runs inside UIKit's layout. Send the event after it.
      DispatchQueue.main.async { [weak self] in
        self?.onSheetLayout(["maxHeight": maximum])
      }
    }
    let height = bounds.height
    return height > 0 ? min(height, maximum) : maximum
  }

  private func refit() {
    guard let found = controller, let sheet = found.sheetPresentationController else { return }
    if found.isBeingPresented || found.presentingViewController == nil {
      sheet.invalidateDetents()
    } else {
      sheet.animateChanges { sheet.invalidateDetents() }
    }
  }

  @objc private func keyboardWillChange(_ notification: Notification) {
    guard let frame = keyboardEndFrame(notification) else { return }
    keyboardFrame = frame
    // UIKit moves the sheet for the keyboard in its own observer. Measure once it has.
    DispatchQueue.main.async { [weak self] in
      self?.measureKeyboard()
    }
  }

  @objc private func keyboardDidChange(_ notification: Notification) {
    guard let frame = keyboardEndFrame(notification) else { return }
    keyboardFrame = frame
    measureKeyboard()
  }

  private func keyboardEndFrame(_ notification: Notification) -> CGRect? {
    (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
  }

  // UIKit lifts the detent above the keyboard. Constrain long, scrollable content to the
  // remaining screen space without adding keyboard height to the detent a second time.
  private func measureKeyboard() {
    guard let window, !keyboardFrame.isNull else { return }
    let frame = window.convert(keyboardFrame, from: window.screen.coordinateSpace)
    let docked = frame.minY < window.bounds.maxY && frame.maxY >= window.bounds.maxY - 1
    let available = docked ? max(1, frame.minY - window.safeAreaInsets.top - 10) : 0
    guard available != reportedKeyboardHeight else { return }
    reportedKeyboardHeight = available
    onKeyboardInset(["availableHeight": available])
  }
}
