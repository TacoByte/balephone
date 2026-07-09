/*
 *  NetworkInterfaceWasm.h - browser implementation of the NetworkInterface API.
 *
 *  Mirrors the class shapes of Source_Files/Network/NetworkInterface.h so all
 *  higher networking code (CommunicationsChannel, star protocol, dialogs)
 *  compiles unchanged. Underneath, everything is multiplexed over a single
 *  WebSocket to a relay server:
 *
 *    - Room members get ids 1..N, mapped to virtual IPv4 10.0.0.<id>.
 *      The engine serializes topology addresses as 4 raw bytes + port, so
 *      virtual addresses survive the existing wire format.
 *    - "TCP" = relay-routed byte streams (reliable, ordered).
 *    - "UDP" = relay-routed datagram frames (also reliable here; the star
 *      protocol only assumes datagrams *may* be lost, so that's fine).
 *
 *  Implementation in net_relay.cpp.
 */

#ifndef NETWORK_INTERFACE_WASM_H
#define NETWORK_INTERFACE_WASM_H

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

class IPaddress {
private:
    std::array<uint8_t, 4> _ip = {0, 0, 0, 0};
    uint16_t _port = 0;

public:
    IPaddress(const std::string& host, uint16_t port);
    IPaddress(const uint8_t ip[4], uint16_t port);
    IPaddress() = default;

    bool is_v4() const { return true; }
    std::string address() const;
    std::array<unsigned char, 4> address_bytes() const { return _ip; }
    uint16_t port() const { return _port; }
    void set_port(uint16_t port) { _port = port; }
    void set_address(const std::string& host);
    void set_address(const uint8_t ip[4]);

    // Relay member id <-> virtual address
    static IPaddress from_member(int member, uint16_t port);
    int member() const { return _ip[0] == 10 && _ip[1] == 0 && _ip[2] == 0 ? _ip[3] : -1; }

    bool operator==(const IPaddress& other) const { return _ip == other._ip && _port == other._port; }
    bool operator!=(const IPaddress& other) const { return !(*this == other); }
};

#define ddpMaxData 1500

struct UDPpacket
{
    IPaddress address;
    std::array<uint8_t, ddpMaxData> buffer;
    int data_size;
};

class UDPsocket {
private:
    uint16_t _port;
    UDPpacket* _async_packet = nullptr;
    explicit UDPsocket(uint16_t port);
    friend class NetworkInterface;

public:
    ~UDPsocket();
    int64_t broadcast_send(const UDPpacket& packet);
    int64_t send(const UDPpacket& packet);
    int64_t receive(UDPpacket& packet); // non-blocking; <= 0 if nothing queued
    void register_receive_async(UDPpacket& packet);
    int64_t receive_async(int timeout_ms);
    // There's no LAN broadcast on the web; pretend it works and drop the
    // packets in broadcast_send, so SSLP's state machine stays consistent
    // (its teardown asserts that setup succeeded).
    bool broadcast(bool enable) { return true; }
    int64_t check_receive() const;
};

class TCPsocket {
private:
    int _stream; // relay stream handle
    explicit TCPsocket(int stream) : _stream(stream) {}
    friend class NetworkInterface;
    friend class TCPlistener;

public:
    ~TCPsocket();
    int64_t send(uint8_t* buffer, size_t size);
    int64_t receive(uint8_t* buffer, size_t size); // non-blocking; 0 = nothing, -1 = closed
    IPaddress remote_address() const;
    bool set_non_blocking(bool enable) { return true; } // always non-blocking
};

class TCPlistener {
private:
    uint16_t _port;
    explicit TCPlistener(uint16_t port);
    friend class NetworkInterface;

public:
    ~TCPlistener();
    std::unique_ptr<TCPsocket> accept_connection();
    bool set_non_blocking(bool enable) { return true; }
};

class NetworkInterface {
public:
    NetworkInterface() = default;
    std::unique_ptr<UDPsocket> udp_open_socket(uint16_t port);
    std::unique_ptr<TCPsocket> tcp_connect_socket(const IPaddress& address);
    std::unique_ptr<TCPlistener> tcp_open_listener(uint16_t port);
    // On the web, "host" is a relay room code; joins the room and returns the
    // gatherer's virtual address (member 1). Dotted-quad strings parse as-is.
    std::optional<IPaddress> resolve_address(const std::string& host, uint16_t port);
};

#endif // NETWORK_INTERFACE_WASM_H
