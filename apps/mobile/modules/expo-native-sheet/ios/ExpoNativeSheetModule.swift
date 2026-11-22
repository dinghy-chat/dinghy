import ExpoModulesCore

public final class ExpoNativeSheetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoNativeSheet")

    View(ExpoNativeSheetView.self) {
      Events("onSheetLayout", "onKeyboardInset", "onWindow")

      Prop("dark") { (view, dark: Bool) in
        view.setDark(dark)
      }
    }
  }
}
