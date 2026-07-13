Pod::Spec.new do |s|
  s.name           = 'ZeroconfNsd'
  s.version        = '1.0.0'
  s.summary        = 'mDNS helpers for rn-mdns-mqtt'
  s.description    = 'Fast IPv4-only .local hostname resolution (skips AAAA mDNS timeout).'
  s.author         = ''
  s.homepage       = 'https://example.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
