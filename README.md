# TRACE/CORE

A local-first, privacy-focused identity, signed chat, and verifiable contribution studio for the Technocore (`technocore.chat`) protocol within the FLOP ecosystem.

Built with Next.js 15, React 19, TypeScript, and Web Crypto standards.

- 🌐 **Live Studio:** [https://tracecore-flop.vercel.app](https://tracecore-flop.vercel.app)
- 📦 **GitHub Repository:** [https://github.com/yusufky63/trace-core](https://github.com/yusufky63/trace-core)

---

## Key Features

### 1. Local-First Identity & Vault Management
- **Ed25519 `did:key` Generation:** Cryptographic key pairs are derived and held purely in-browser. Private seeds **never** leave client memory or get transmitted across the wire.
- **Client-Side PBKDF2 + AES-GCM Encryption:** Stores the encrypted seed, linked profile coordinates, mailbox identifier, and contribution proof history in `localStorage`.
- **Seamless Session Hydration:** Once initialized, opening the app requires only entering your master vault password (`UNLOCK LOCAL VAULT`). All social handles, mailbox coordinates, and proof receipts are instantly hydrated without needing manual JSON re-imports or re-entry.
- **Encrypted Portability:** Export and import versioned JSON backup vaults across devices securely.

### 2. Live Signed Chat Engine
- **Verifiable Room Messaging:** Signs messages over `room|nonce|text` using client-side Ed25519 private keys.
- **Sequence Merging & Deduplication:** Intelligently merges incoming messages by sequence ID (`seq`), avoiding message flickers, duplicates, or full list wipes on polling cycles.
- **Optimistic Posting & Feedback:** Immediately displays pending messages in the live feed while awaiting Technocore signature receipts and block sequences.
- **Smart Auto-Scroll & Jump Controls:** Maintains scroll position when reading past messages and displays a floating `↓ NEW MESSAGES` indicator. Automatically scrolls down when actively reading at the bottom or posting.
- **Real-Time Search & Trust Filters:** Filter messages by search query, `ALL`, `SIGNED ONLY` (cryptographically verified by Technocore), or `MY MESSAGES`.
- **Keyboard Ergonomics:** Press `Enter` to broadcast instantly, `Shift+Enter` for multi-line formatting.

### 3. Public Profile & Capability Mailbox
- **Sharded Fingerprint Notes:** Publishes DID profile coordinate records to Technocore's `/kv/did-xx/yy` directory.
- **144-Bit Unlisted Mailbox:** Creates random unlisted signed-write mailbox channels (`mb-p-*`) where capability URL access is combined with sender-attributable signatures.

### 4. Verifiable Contribution Proofs
- **Cryptographic Attribution:** Record and sign public contribution URLs (e.g. GitHub repos, PRs, tooling) directly to `/r/technocore`.
- **Portable Proof Export:** Export a standardized `trace-core-public-proof.json` containing the payload, signature, DID, and Technocore server sequence receipt for independent verification.

---

## Design System: Modular Typography

TRACE/CORE uses a strict **Modular Typography** aesthetic:
- Hard 1px ink grid borders and numbered modules (`01 START`, `02 CHAT`, `03 PROFILE`, `04 PROOF`).
- Off-white paper palette (`#f2f0e9`), rich black ink (`#11110f`), and signal warm accents (`#ff5b2e`).
- Focus-first single workspace visibility to reduce cognitive overload.

---

## Getting Started

### Prerequisites
- Node.js 18.18+ or 20+
- npm or pnpm

### Installation & Run

```bash
# Clone or enter the project directory
cd trac-core

# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Suggested Contribution Flow

1. **Create Identity:** Enter a strong password to generate your local `did:key` and download an encrypted backup.
2. **Set Profile:** Link your X handle, GitHub URL, and generate your unlisted mailbox.
3. **Engage in Live Chat:** Join public rooms (`lobby`, `technocore`) or create topic rooms.
4. **Build for the Ecosystem:** Develop a tool, contract, bridge, translation, or integration.
5. **Publish & Deploy:** Host your project publicly on GitHub / Vercel.
6. **Record Contribution Proof:** Paste your repository/demo URL in the **PROOF** tab and record your signed proof.
7. **Export & Share:** Download `trace-core-public-proof.json` and share your verifiable trail.

---

## Security Architecture

- **Private Key Isolation:** Private seeds exist only in ephemeral JavaScript memory during an unlocked session.
- **Fixed-Origin Proxy (`/api/technocore`):** Restricts requests to `https://technocore.chat`, strictly validates path formats and payload byte boundaries, checks same-origin headers, and enforces client rate limits.
- **Monotonic Nonces:** Local monotonic room counters protect against replay attacks and clock skew across multiple tabs.

---

## Protocol References

- [FLOP Specification](https://flop.finance/llms.txt)
- [Technocore Protocol](https://technocore.chat/llms.txt)
- [Technocore Patterns](https://technocore.chat/patterns.md)
- [Technocore Reference Implementation](https://github.com/flop-labs/technocore-chat)

---

## License

MIT License. Developed as an open utility for the Technocore & FLOP ecosystem.

