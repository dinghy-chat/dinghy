import ExpoModulesCore
import UIKit

final class ExpoNativeTabBarView: ExpoView, UITabBarDelegate {
  let onPage = EventDispatcher()

  private static let pages = ["inbox", "contacts", "visitors", "analytics", "settings"]
  private static let symbols = [
    ("tray", "tray.fill"),
    ("person.crop.rectangle.stack", "person.crop.rectangle.stack.fill"),
    ("globe", "globe.americas.fill"),
    ("chart.bar", "chart.bar.fill"),
    ("person.crop.circle", "person.crop.circle.fill")
  ]

  private let tabBar = UITabBar()
  private var page = "inbox"

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .clear
    clipsToBounds = false

    let items = Self.pages.enumerated().map { index, page in
      let symbols = Self.symbols[index]
      let item = UITabBarItem(
        title: nil,
        image: UIImage(systemName: symbols.0),
        selectedImage: UIImage(systemName: symbols.1)
      )
      item.tag = index
      item.accessibilityLabel = page
      return item
    }

    // Style the counter on its item so UIKit owns the bar's glass and selection.
    let visitors = items[2]
    visitors.badgeColor = .label
    for state: UIControl.State in [.normal, .selected] {
      visitors.setBadgeTextAttributes([
        .foregroundColor: UIColor.systemBackground,
        .font: UIFont.systemFont(ofSize: 10, weight: .semibold)
      ], for: state)
    }
    tabBar.items = items
    tabBar.selectedItem = items.first
    tabBar.delegate = self
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    addSubview(tabBar)

    NSLayoutConstraint.activate([
      tabBar.topAnchor.constraint(equalTo: topAnchor),
      tabBar.bottomAnchor.constraint(equalTo: bottomAnchor),
      tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      tabBar.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
  }

  func setPage(_ nextPage: String) {
    guard let index = Self.pages.firstIndex(of: nextPage),
      let item = tabBar.items?[index] else {
      return
    }
    page = nextPage
    tabBar.selectedItem = item
  }

  func setLiveCount(_ count: Int?) {
    guard let item = tabBar.items?[2] else {
      return
    }
    guard let count, count > 0 else {
      item.badgeValue = nil
      return
    }
    item.badgeValue = count > 99 ? "99+" : String(count)
  }

  func setDark(_ dark: Bool) {
    overrideUserInterfaceStyle = dark ? .dark : .light
  }

  func setLabel(_ label: String, for page: String) {
    guard let index = Self.pages.firstIndex(of: page) else {
      return
    }
    tabBar.items?[index].accessibilityLabel = label
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    emitPage(at: item.tag)
  }

  private func emitPage(at index: Int) {
    guard Self.pages.indices.contains(index) else {
      return
    }
    let nextPage = Self.pages[index]
    guard nextPage != page else {
      return
    }
    onPage(["page": nextPage])
  }
}
