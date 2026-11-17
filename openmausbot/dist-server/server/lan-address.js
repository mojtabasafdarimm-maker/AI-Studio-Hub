import { networkInterfaces } from "node:os";
import { isPrivateHost } from "../shared/private-host.js";
/** Bridges, VMs and VPN tunnels: their addresses reach this machine's containers or a VPN, not the person's devices. */
const HOST_ONLY_INTERFACE = /^(?:docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|ppp|ipsec|bridge\d|vethernet)/i;
/** Tailscale's IPv6 prefix; 100.64/10 alone is shared with carrier NAT and other VPNs. */
const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i;
const cgnat = (address) => {
    const [a, b] = address.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
};
/** Read afresh on every call, so a new Wi-Fi network or DHCP lease shows up in the next code's link. */
export function reachableAddresses(interfaces = networkInterfaces()) {
    const lan = [];
    const shared = [];
    const tailscale = [];
    for (const [name, entries = []] of Object.entries(interfaces)) {
        const v4 = entries.filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
        if (/^tailscale/i.test(name) || entries.some((entry) => TAILSCALE_V6.test(entry.address))) {
            tailscale.push(...v4.filter(cgnat));
            continue;
        }
        if (HOST_ONLY_INTERFACE.test(name))
            continue;
        for (const address of v4) {
            if (!isPrivateHost(address) || address.startsWith("127.") || address.startsWith("169.254."))
                continue;
            (cgnat(address) ? shared : lan).push(address);
        }
    }
    return { lan: [...lan, ...shared], tailscale };
}
const plain = (address) => (address ?? "").replace(/^::ffff:/i, "");
/** Both ends of a connection on a network the person runs: a LAN listener answers nobody on the open internet. */
export function privateConnection(localAddress, remoteAddress) {
    return isPrivateHost(plain(localAddress)) && isPrivateHost(plain(remoteAddress));
}
/** Where the server listens: loopback, or with OMB_LAN=1 every IPv4 address with each connection held to private ends,
 * so a new Wi-Fi network or DHCP lease needs no restart. */
export function listenHost(server, env = process.env) {
    if (env.OMB_LAN !== "1")
        return "127.0.0.1";
    server.on("connection", (socket) => {
        if (!privateConnection(socket.localAddress, socket.remoteAddress))
            socket.destroy();
    });
    return "0.0.0.0";
}
/** With OMB_LAN=1, the address other devices on this network use, read afresh for each link; else null. */
export function lanUrl(port, env = process.env, addresses = reachableAddresses) {
    if (env.OMB_LAN !== "1")
        return null;
    const address = addresses().lan[0];
    return address ? `http://${address}:${port}` : null;
}
