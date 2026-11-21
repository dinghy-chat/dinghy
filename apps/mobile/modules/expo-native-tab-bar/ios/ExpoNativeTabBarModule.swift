import ExpoModulesCore

public final class ExpoNativeTabBarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoNativeTabBar")

    View(ExpoNativeTabBarView.self) {
      Events("onPage")

      Prop("page") { (view, page: String) in
        view.setPage(page)
      }

      Prop("liveCount") { (view, liveCount: Int?) in
        view.setLiveCount(liveCount)
      }

      Prop("dark") { (view, dark: Bool) in
        view.setDark(dark)
      }

      Prop("inboxLabel") { (view, label: String) in
        view.setLabel(label, for: "inbox")
      }

      Prop("contactsLabel") { (view, label: String) in
        view.setLabel(label, for: "contacts")
      }

      Prop("visitorsLabel") { (view, label: String) in
        view.setLabel(label, for: "visitors")
      }

      Prop("analyticsLabel") { (view, label: String) in
        view.setLabel(label, for: "analytics")
      }

      Prop("settingsLabel") { (view, label: String) in
        view.setLabel(label, for: "settings")
      }
    }

    View(ExpoNativeSearchFieldView.self) {
      Events("onQuery")

      Prop("query") { (view, query: String) in
        view.setQuery(query)
      }

      Prop("placeholder") { (view, placeholder: String) in
        view.setPlaceholder(placeholder)
      }

      Prop("label") { (view, label: String) in
        view.setLabel(label)
      }

      Prop("dark") { (view, dark: Bool) in
        view.setDark(dark)
      }
    }
  }
}
