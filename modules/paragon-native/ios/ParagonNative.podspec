Pod::Spec.new do |s|
  s.name           = 'ParagonNative'
  s.version        = '1.0.0'
  s.summary        = 'BLE scanning, gateway ticker and TCP/TLS sockets for the Paragon app'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Identyca'
  s.homepage       = 'https://identyca.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth', 'Network'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
