import ExpoModulesCore
import UIKit

// The Inbox search above the tab bar: UIKit's search field on the system material.
final class ExpoNativeSearchFieldView: ExpoView, UITextFieldDelegate {
  let onQuery = EventDispatcher()

  private let material = UIVisualEffectView(effect: nil)
  private let field = UISearchTextField()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .clear
    // Body text grows with Dynamic Type up to 23 pt, which still fits the 44 pt capsule.
    maximumContentSizeCategory = .extraExtraExtraLarge

    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = true
      material.effect = glass
      material.cornerConfiguration = .capsule()
    } else {
      material.effect = UIBlurEffect(style: .systemThickMaterial)
      material.clipsToBounds = true
      material.layer.cornerCurve = .continuous
    }
    material.translatesAutoresizingMaskIntoConstraints = false
    addSubview(material)

    // The material is the capsule, so the field drops its own fill.
    field.borderStyle = .none
    field.backgroundColor = .clear
    field.font = UIFont.preferredFont(forTextStyle: .body)
    field.adjustsFontForContentSizeCategory = true
    field.clearButtonMode = .whileEditing
    field.returnKeyType = .search
    field.autocapitalizationType = .none
    field.autocorrectionType = .no
    field.spellCheckingType = .no
    field.delegate = self
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    field.translatesAutoresizingMaskIntoConstraints = false
    material.contentView.addSubview(field)

    NSLayoutConstraint.activate([
      material.topAnchor.constraint(equalTo: topAnchor),
      material.bottomAnchor.constraint(equalTo: bottomAnchor),
      material.leadingAnchor.constraint(equalTo: leadingAnchor),
      material.trailingAnchor.constraint(equalTo: trailingAnchor),
      field.topAnchor.constraint(equalTo: material.contentView.topAnchor),
      field.bottomAnchor.constraint(equalTo: material.contentView.bottomAnchor),
      field.leadingAnchor.constraint(equalTo: material.contentView.leadingAnchor, constant: 12),
      field.trailingAnchor.constraint(equalTo: material.contentView.trailingAnchor, constant: -8)
    ])
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if #unavailable(iOS 26.0) {
      material.layer.cornerRadius = bounds.height / 2
    }
  }

  func setQuery(_ query: String) {
    // Only write outside changes, so typing keeps the caret and marked text.
    if field.text != query {
      field.text = query
    }
  }

  func setPlaceholder(_ placeholder: String) {
    field.attributedPlaceholder = NSAttributedString(
      string: placeholder, attributes: [.foregroundColor: UIColor.secondaryLabel]
    )
  }

  func setLabel(_ label: String) {
    field.accessibilityLabel = label
  }

  func setDark(_ dark: Bool) {
    overrideUserInterfaceStyle = dark ? .dark : .light
  }

  @objc private func changed() {
    onQuery(["query": field.text ?? ""])
  }

  func textFieldShouldClear(_ textField: UITextField) -> Bool {
    onQuery(["query": ""])
    return true
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }
}
