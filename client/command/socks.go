package command

import (
	"context"
	"fmt"
	"net"
	"strings"

	"github.com/bishopfox/sliver/protobuf/sliverpb"

	"github.com/bishopfox/sliver/client/core"
	"github.com/bishopfox/sliver/protobuf/rpcpb"

	"github.com/desertbit/grumble"
)

func socks(ctx *grumble.Context, rpc rpcpb.SliverRPCClient) {
	session := ActiveSession.GetInteractive()
	if session == nil {
		return
	}

	port := ctx.Flags.Int("port")
	go startSocksServer(ctx, port, rpc)
}

func startSocksServer(ctx *grumble.Context, port int, rpc rpcpb.SliverRPCClient) {
	fmt.Printf(Info + fmt.Sprintf("Starting socks server on port %d\n\n", port))
	session := ActiveSession.Get()
	if session == nil {
		fmt.Printf(Warn+"%s\n", "Current session is nil")
		return
	}

	netAddr, err := net.ResolveTCPAddr("tcp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		fmt.Printf(Warn+"%s\n", err)
		return
	}

	listener, err := net.ListenTCP("tcp4", netAddr)
	if err != nil {
		fmt.Printf(Warn+"%s\n", err)
		return
	}

	var socksConnList []*net.TCPConn

	// If session is closed then close the socks server
	go func(implantSessionID uint32) {
		// Continuously check if the connection to the implant that opened the socks server is still alive
		for GetSession(fmt.Sprintf("%d", implantSessionID), rpc) != nil {
		}

		fmt.Println(Warn + " Closing all socks connections")
		for _, conn := range socksConnList {
			_ = conn.Close()
		}

		fmt.Println(Warn + " Killing socks server")
		listener.Close()
	}(session.ID)

	for {
		conn, err := listener.AcceptTCP()
		if err != nil {
			if strings.Contains(err.Error(), "use of closed network connection") {
				break
			} else {
				fmt.Printf(Warn+"%s\n", err)
			}
		}

		socksConnList = append(socksConnList, conn)
		go handleConnection(ctx, conn, rpc)
	}

	listener.Close()
}

func handleConnection(ctx *grumble.Context, conn *net.TCPConn, rpc rpcpb.SliverRPCClient) {
	socksConn := new(SocksConn)
	socksConn.ClientConn = conn

	// Negotiate authentication
	err := socksConn.HandleAuthRequest()
	if err != nil {
		fmt.Printf("%s\n", err)
		return
	}

	// Handle socks connection request
	err = socksConn.HandleConnectRequest()
	if err != nil {
		fmt.Printf("%s\n", err)
		return
	}

	session := ActiveSession.Get()
	if session == nil {
		return
	}

	// Create an RPC tunnel, then start it before binding the shell to the newly created tunnel
	rpcTunnel, err := rpc.CreateTunnel(context.Background(), &sliverpb.Tunnel{
		SessionID: session.ID,
	})
	if err != nil {
		fmt.Printf(Warn+"%s\n", err)
		return
	}

	// Start() takes an RPC tunnel and creates a local Reader/Writer tunnel object
	tunnel := core.Tunnels.Start(rpcTunnel.TunnelID, rpcTunnel.SessionID)
	if err != nil {
		fmt.Printf(Warn+"%s\n", err)
		return
	}

	tcpTunnel, err := rpc.TCPTunnel(context.Background(), &sliverpb.TCPTunnelReq{
		RemoteHost: socksConn.RemoteHost,
		RemotePort: socksConn.RemotePort,
		Request:    ActiveSession.Request(ctx),
		TunnelID:   tunnel.ID,
	})
	if err != nil {
		fmt.Printf(Warn+"%s\n", err)
		return
	}

	if tcpTunnel.StatusCode == 0x00 {
		socksConn.ReturnSuccessConnectMessage()

		cleanup := func() {
			// Close the client socket
			_ = socksConn.ClientConn.Close()

			if core.Tunnels.Get(tunnel.ID) != nil {
				// Send a message to close the tunnel
				_, err := rpc.CloseTunnel(context.Background(), &sliverpb.Tunnel{
					TunnelID: tunnel.ID,
				})
				if err != nil {
					// {{if .Config.Debug}}
					fmt.Printf(Warn+"%s\n", err)
					// {{end}}
					return
				}
			}
		}

		go func() {
			for tunnel.IsOpen {
				readArray := make([]byte, 1024)
				bytesRead, err := tunnel.Read(readArray)
				if err != nil {
					cleanup()
				} else if bytesRead != 0 {
					_, err := socksConn.ClientConn.Write(readArray[:bytesRead])
					// {{if .Config.Debug}}
					fmt.Printf("[tunnel] Read %d bytes from tunnel\n", bytesRead)
					// {{end}}
					if err != nil {
						cleanup()
					}
				}
			}
		}()

		go func() {
			for tunnel.IsOpen {
				writeArray := make([]byte, 1024)
				bytesToWrite, err := socksConn.ClientConn.Read(writeArray)
				if err != nil {
					cleanup()
				} else if bytesToWrite != 0 {
					_, err = tunnel.Write(writeArray[:bytesToWrite])
					// {{if .Config.Debug}}
					fmt.Printf("[tunnel] Write %d bytes to tunnel\n", bytesToWrite)
					// {{end}}
					if err != nil {
						cleanup()
					}
				}
			}
		}()
	} else {
		socksConn.ReturnFailureConnectMessage()
	}
}
