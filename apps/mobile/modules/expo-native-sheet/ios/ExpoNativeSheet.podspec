require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoNativeSheet'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Dinghy'
  s.homepage       = 'https://dinghy.chat'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => 'https://github.com/dinghy-chat/dinghy.git' }

  s.dependency 'ExpoModulesCore'

  s.static_framework = true
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift}'
end
