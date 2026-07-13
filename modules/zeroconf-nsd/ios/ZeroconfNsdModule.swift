import ExpoModulesCore

public class ZeroconfNsdModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ZeroconfNsd")

    // IPv4-only getaddrinfo issues a single mDNS A query; AF_UNSPEC (as used by
    // CocoaAsyncSocket) also waits ~5s for an AAAA answer embedded brokers never send.
    AsyncFunction("resolveHostname") { (hostname: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_STREAM

        var result: UnsafeMutablePointer<addrinfo>? = nil
        let status = getaddrinfo(hostname, nil, &hints, &result)
        defer {
          if result != nil {
            freeaddrinfo(result)
          }
        }
        guard status == 0 else {
          promise.resolve([String]())
          return
        }

        var addresses: [String] = []
        var cursor = result
        while let info = cursor {
          if info.pointee.ai_family == AF_INET, let addr = info.pointee.ai_addr {
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
              var inAddr = sin.pointee.sin_addr
              _ = inet_ntop(AF_INET, &inAddr, &buffer, socklen_t(INET_ADDRSTRLEN))
            }
            let ip = String(cString: buffer)
            if !ip.isEmpty && !addresses.contains(ip) {
              addresses.append(ip)
            }
          }
          cursor = info.pointee.ai_next
        }
        promise.resolve(addresses)
      }
    }
  }
}
