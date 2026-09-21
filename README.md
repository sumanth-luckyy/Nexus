# Nexus

### Connect. Communicate. Share.

Nexus is a real-time peer-to-peer communication and sharing platform built around direct browser-to-browser connections.

It enables two people to connect through a temporary room and communicate using video, audio, chat, screen sharing, and direct file transfer.

---

## ✨ Features

### 🎥 Video & Audio
- Real-time peer-to-peer video calling
- Camera and microphone controls
- Local and remote video
- Connection status
- Fullscreen support
- Screen sharing
- Automatic camera restoration after screen sharing

### 💬 Real-Time Chat
- Instant peer-to-peer messaging
- WebRTC DataChannel communication
- Temporary session-based conversations

### 📁 P2P File Sharing
- Direct browser-to-browser file transfer
- WebRTC DataChannel based transfers
- No traditional server-side file storage required
- Designed for temporary private sharing

### 🔐 Secure Rooms
- Temporary room-based communication
- Optional room PIN/password protection
- Server-side room authorization
- Host/guest access control
- Room lifecycle management
- Protected signaling flow

### 📱 QR Room Joining
Generate a QR code for a room and allow another device to scan it for quick joining.

### 🖥️ Screen Sharing
Share your entire screen, an application window, or a browser tab using the browser's native `getDisplayMedia()` API.

### 🎨 Modern Interface
- Premium, minimal dark interface
- Responsive design
- Scholar + Poppins typography
- Smooth animations
- Glass-style UI elements
- Silk shader background
- Theme support
- Desktop and mobile friendly

---

## 🧠 How Nexus Works

Nexus uses WebRTC to establish a direct connection between participants.

```text
                    Nexus Server
                  Signaling Layer
                         │
             ┌───────────┴───────────┐
             │                       │
          Browser A              Browser B
             │                       │
             └────── WebRTC P2P ─────┘
```

The Nexus server is primarily responsible for creating and managing rooms, connecting participants, WebRTC signaling, SDP offer/answer exchange, ICE candidate exchange, room authorization, and temporary room state.

After a WebRTC connection is established, supported communication can travel directly between the browsers.

---

## 🔒 Privacy Architecture

Nexus is designed around temporary peer-to-peer communication.

### Temporary server-side state

The signaling server may temporarily maintain:

- Room information
- Host/guest connection state
- Socket IDs
- Room authorization state
- WebRTC signaling messages

### Direct data transfer

Video, audio, chat messages, and file transfers are designed to use WebRTC between connected peers.

Nexus does not require a traditional database for the core communication flow.

> WebRTC may use a TURN relay when a direct peer-to-peer connection cannot be established. In that case, traffic can pass through the TURN server.

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────┐
│                    Nexus                    │
├─────────────────────────────────────────────┤
│                                             │
│  Frontend                                   │
│  ├── HTML                                   │
│  ├── CSS                                    │
│  └── JavaScript                             │
│                                             │
│  Signaling Server                           │
│  ├── Node.js                                │
│  ├── Express                                │
│  └── Socket.IO                              │
│                                             │
│  Real-Time Communication                    │
│  ├── WebRTC                                 │
│  ├── WebRTC DataChannel                     │
│  ├── ICE                                    │
│  └── SDP                                    │
│                                             │
│  Connectivity                               │
│  ├── STUN                                   │
│  └── TURN                                   │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 🛠️ Technology Stack

### Frontend
- HTML5
- CSS3
- JavaScript
- WebRTC APIs
- WebRTC DataChannel
- Three.js
- QR code generation

### Backend
- Node.js
- Express
- Socket.IO

### Networking
- WebRTC
- STUN
- TURN
- ICE
- SDP

---

## 📂 Project Structure

```text
nexus/
├── public/
│   ├── index.html
│   ├── room.html
│   ├── script.js
│   ├── style.css
│   ├── silk.js
│   ├── qrcode.min.js
│   └── fonts/
│       ├── Scholar.otf
│       └── Poppins.ttf
├── server.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
cd YOUR_REPOSITORY
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file based on `.env.example`.

```env
NODE_ENV=development
PORT=3000

TURN_URL=
TURN_USERNAME=
TURN_PASSWORD=
```

Never commit your real `.env` file or private credentials.

### 4. Start the server

```bash
npm start
```

The application will normally be available at:

```text
http://localhost:3000
```

---

## 🌐 Production Deployment

For production, Nexus should be served over HTTPS.

A secure production deployment is important because browsers require a secure context for camera, microphone, and screen-sharing features.

Recommended architecture:

```text
HTTPS
  │
  ▼
Nexus Node.js Server
  │
  ├── Express
  ├── Socket.IO
  │
  ▼
WebRTC Signaling
  │
  ├──────────────┐
  ▼              ▼
Browser A     Browser B
```

For users behind restrictive networks, a properly configured TURN server may be required.

---

## ⚙️ Environment Variables

| Variable | Description |
|---|---|
| `NODE_ENV` | Application environment |
| `PORT` | Server port |
| `TURN_URL` | TURN server URL |
| `TURN_USERNAME` | TURN authentication username |
| `TURN_PASSWORD` | TURN authentication password |

Never expose private TURN credentials in frontend JavaScript.

---

## 🔐 Security Considerations

Nexus is designed with security in mind.

Important security areas include:

- Server-side room authorization
- Protected room PIN verification
- Secure room generation
- Signaling validation
- Connection limits
- Input validation
- Rate limiting
- Secure HTTP headers
- Safe chat rendering
- File transfer validation
- Environment variable protection
- HTTPS/WSS deployment
- Proper WebRTC permission handling

Before exposing a public instance, review the server, dependencies, configuration, and WebRTC/TURN deployment.

---

## 🧪 Testing Checklist

### Same device
- [ ] Two browser tabs
- [ ] Two browser windows

### Same network
- [ ] Laptop + phone
- [ ] Different browsers

### Different networks
- [ ] Wi-Fi + mobile hotspot
- [ ] Two separate internet connections

### Core features
- [ ] Room creation
- [ ] Room joining
- [ ] PIN-protected rooms
- [ ] Camera
- [ ] Microphone
- [ ] Video
- [ ] Audio
- [ ] Chat
- [ ] File transfer
- [ ] Screen sharing
- [ ] QR joining
- [ ] Fullscreen
- [ ] Connection recovery
- [ ] Mobile browser compatibility
- [ ] TURN connectivity

---

## 🛡️ Browser Permissions

Nexus may request permission for:

- Camera
- Microphone
- Screen sharing

These permissions are controlled by the browser and operating system. Users should only grant permissions they are comfortable providing.

---

## 📌 Roadmap

Potential future improvements include:

- Multi-user rooms
- Voice-only calls
- Advanced WebRTC diagnostics
- Camera and microphone device selection
- Video quality controls
- Picture-in-picture
- Shared notes
- Transfer history
- One-time rooms
- Custom room names
- Additional collaboration tools
- Improved mobile experience
- Connection quality indicators

---

## 🤝 Contributing

Contributions are welcome.

### Create a feature branch

```bash
git checkout -b feature/your-feature
```

### Commit your changes

```bash
git add .
git commit -m "Add your feature"
```

### Push the branch

```bash
git push origin feature/your-feature
```

Then open a Pull Request.

---

## 📜 License

This project currently does not specify a license.

If you intend to distribute Nexus as an open-source project, add an appropriate license before accepting external contributions.

---

## ⚠️ Disclaimer

Nexus is a software project for real-time communication and peer-to-peer sharing.

Users are responsible for how they use the application and for complying with applicable laws, regulations, and third-party service terms.

---

## 👨‍💻 Built With

**HTML · CSS · JavaScript · Node.js · Express · Socket.IO · WebRTC**

---

# Nexus

### Connect. Communicate. Share.
