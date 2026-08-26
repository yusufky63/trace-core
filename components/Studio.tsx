"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DID_PATTERN, MAILBOX_PATTERN, NAME_PATTERN, codePointLength, createIdentity,
  createIdentityBackup, createMailboxName, decryptSeed, didFingerprint, downloadJson,
  encryptSeed, nextRoomNonce, parseIdentityBackup, signRoomMessage, sweepSingleLine,
  verifyRoomMessage, type ContributionProofRecord, type IdentityActivity,
  type IdentityBackup, type TechnocoreReceipt, type VaultPayload,
} from "@/lib/identity";
import { technocore } from "@/lib/technocore";

type Log = { at: string; label: string; detail: string; ok: boolean };
type ProofInput = { contributionUrl: string; description: string };
type Mode = "start" | "chat" | "profile" | "proof";
type ChatFilter = "all" | "signed" | "mine";
type ChatMessage = { seq: number; ts: string; from: string; text: string; nonce: number | null; pending?: boolean };
type Feedback = { ok: boolean; text: string };

const STORAGE_KEY = "trace-core-identity-v2";
const LEGACY_STORAGE_KEY = "trace-core-vault";
const CHAT_SETTINGS_KEY = "trace-core-chat-settings-v1";
const EMPTY_ACTIVITY: IdentityActivity = { profilePublishedAt: null, signedMessageAt: null, proofRecordedAt: null };
const INITIAL_PROOF: ProofInput = { contributionUrl: "", description: "Built a useful Technocore tool for the FLOP ecosystem." };
const SOURCES = ["https://flop.finance/llms.txt", "https://technocore.chat/llms.txt", "https://github.com/flop-labs/technocore-chat"];
const MODES: Array<{ id: Mode; number: string; label: string }> = [
  { id: "start", number: "01", label: "START / IDENTITY" },
  { id: "chat", number: "02", label: "CHAT" },
  { id: "profile", number: "03", label: "PROFILE" },
  { id: "proof", number: "04", label: "PROOF" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validXHandle(value: string) { return !value || /^@?[A-Za-z0-9_]{1,30}$/.test(value); }

function parseChatMessages(value: unknown): ChatMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Technocore returned an invalid room response.");
  const messages: ChatMessage[] = [];
  for (const item of value.messages) {
    if (!isRecord(item)) continue;
    if (!Number.isSafeInteger(item.seq) || typeof item.ts !== "string" || typeof item.from !== "string" || typeof item.text !== "string") continue;
    if (codePointLength(item.text) > 4096 || item.from.length > 128) continue;
    messages.push({ seq: item.seq as number, ts: item.ts, from: item.from, text: item.text, nonce: Number.isSafeInteger(item.nonce) ? item.nonce as number : null });
  }
  return messages;
}

function extractReceipt(result: unknown, did: string, nonce: string): TechnocoreReceipt | null {
  if (!isRecord(result) || !Array.isArray(result.messages)) return null;
  const match = [...result.messages].reverse().find((item) => isRecord(item) && item.from === did && String(item.nonce) === nonce);
  if (!isRecord(match) || typeof match.seq !== "number" || typeof match.ts !== "string" || typeof match.from !== "string" || typeof match.text !== "string" || typeof match.nonce !== "number") return null;
  return { seq: match.seq, ts: match.ts, from: match.from, text: match.text, nonce: match.nonce };
}

function isSignedMessage(item: ChatMessage) { return DID_PATTERN.test(item.from) && item.nonce !== null; }
function shortIdentity(value: string) {
  if (!value) return "~anonymous";
  if (!DID_PATTERN.test(value)) return `~${value}`;
  return `${value.slice(8, 14)}…${value.slice(-5)}`;
}
function formatChatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function roomKind(room: string) {
  if (room.startsWith("mb-p-")) return "UNLISTED SIGNED MAILBOX";
  if (room.startsWith("e-p-")) return "UNLISTED EPHEMERAL";
  if (room.startsWith("p-")) return "UNLISTED · URL IS THE CAPABILITY";
  if (room.startsWith("mb-")) return "SIGNED-WRITE MAILBOX";
  if (room.startsWith("e-")) return "EPHEMERAL ROOM";
  if (room.startsWith("d-")) return "OWNABLE ROOM";
  return "PUBLIC ROOM";
}

async function unlockBackupSeed(backup: IdentityBackup, password: string) {
  try {
    return await decryptSeed(backup.vault, password);
  } catch {
    throw new Error("Password incorrect or encrypted vault is damaged. Please verify your password.");
  }
}

export default function Studio() {
  const [activeMode, setActiveMode] = useState<Mode>("start");
  const [did, setDid] = useState("");
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [vault, setVault] = useState<VaultPayload | null>(null);
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [room, setRoom] = useState("lobby");
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [chatSearch, setChatSearch] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatUpdatedAt, setChatUpdatedAt] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [proof, setProof] = useState<ProofInput>(INITIAL_PROOF);
  const [proofRecord, setProofRecord] = useState<ContributionProofRecord | null>(null);
  const [activity, setActivity] = useState<IdentityActivity>(EMPTY_ACTIVITY);
  const [createdAt, setCreatedAt] = useState("");
  const [logs, setLogs] = useState<Log[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storedVaultAvailable, setStoredVaultAvailable] = useState(false);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  
  const [pendingImport, setPendingImport] = useState<IdentityBackup | null>(null);
  const [isChatFullscreen, setIsChatFullscreen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatLoadIdRef = useRef(0);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const currentRoomRef = useRef(room);

  const cleanMessageLength = codePointLength(sweepSingleLine(message));
  const roomReady = NAME_PATTERN.test(room);
  const profileReady = !!did && MAILBOX_PATTERN.test(mailbox) && validXHandle(xHandle.trim()) && (!profileUrl.trim() || isHttpsUrl(profileUrl.trim()));
  const signalReady = !!seed && roomReady && cleanMessageLength > 0 && cleanMessageLength <= 4096;
  const contributionReady = isHttpsUrl(proof.contributionUrl.trim()) && codePointLength(sweepSingleLine(proof.description)) > 0 && codePointLength(sweepSingleLine(proof.description)) <= 512;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isChatFullscreen) {
        setIsChatFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isChatFullscreen]);

  const progress = useMemo(() => {
    let value = 0;
    if (did) value += 20;
    if (MAILBOX_PATTERN.test(mailbox)) value += 20;
    if (activity.profilePublishedAt) value += 20;
    if (activity.signedMessageAt) value += 20;
    if (activity.proofRecordedAt && proofRecord) value += 20;
    return value;
  }, [activity, did, mailbox, proofRecord]);

  const visibleMessages = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    return chatMessages.filter((item) => {
      if (chatFilter === "signed" && !isSignedMessage(item)) return false;
      if (chatFilter === "mine" && (!did || item.from !== did)) return false;
      if (q && !item.text.toLowerCase().includes(q) && !item.from.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [chatFilter, chatMessages, chatSearch, did]);

  useEffect(() => {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    const chatSettings = localStorage.getItem(CHAT_SETTINGS_KEY);
    if (chatSettings && NAME_PATTERN.test(chatSettings)) setRoom(chatSettings);
    setStoredVaultAvailable(Boolean(current || legacy));
    setStorageReady(true);
  }, []);

  useEffect(() => { if (roomReady) localStorage.setItem(CHAT_SETTINGS_KEY, room); }, [room, roomReady]);

  useEffect(() => {
    if (!storageReady || !vault || !createdAt) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createIdentityBackup(vault, { mailbox, xHandle, profileUrl }, activity, proofRecord, createdAt)));
    setStoredVaultAvailable(true);
  }, [activity, createdAt, mailbox, profileUrl, proofRecord, storageReady, vault, xHandle]);

  function log(label: string, detail: unknown, ok = true) {
    const rendered = typeof detail === "string" ? detail : JSON.stringify(detail);
    setLogs((current) => [{ at: new Date().toLocaleTimeString(), label, detail: rendered, ok }, ...current].slice(0, 16));
  }

  async function run(label: string, fn: () => Promise<void>) {
    setFeedback(null);
    setBusy(label);
    try { 
      await fn(); 
    } catch (error) {
      const msg = error instanceof Error ? error.message : "An unexpected error occurred.";
      setFeedback({ ok: false, text: msg });
      log(label.toUpperCase(), msg, false);
    } finally { 
      setBusy(null); 
    }
  }

  const scrollToBottom = useCallback((smooth = true) => {
    if (!chatFeedRef.current) return;
    chatFeedRef.current.scrollTo({
      top: chatFeedRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setHasUnreadBelow(false);
    isNearBottomRef.current = true;
  }, []);

  const handleChatScroll = useCallback(() => {
    if (!chatFeedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatFeedRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isBottom = distanceFromBottom < 60;
    isNearBottomRef.current = isBottom;
    if (isBottom) setHasUnreadBelow(false);
  }, []);

  const loadChat = useCallback(async (silent = false, resetRoom = false) => {
    if (!NAME_PATTERN.test(room)) {
      setChatError("Room name must use lowercase letters, numbers, - or _ and contain at most 48 characters.");
      return;
    }
    const loadId = ++chatLoadIdRef.current;
    if (!silent) setChatLoading(true);
    try {
      const response = await technocore(`/r/${room}?limit=50&format=json`);
      const parsed = parseChatMessages(response);
      if (loadId !== chatLoadIdRef.current) return;

      setChatMessages((prev) => {
        if (resetRoom) {
          return parsed.sort((a, b) => a.seq - b.seq);
        }
        const map = new Map<number, ChatMessage>();
        for (const item of prev) map.set(item.seq, item);
        for (const item of parsed) map.set(item.seq, item);
        const merged = Array.from(map.values()).sort((a, b) => a.seq - b.seq);

        if (merged.length > prev.length) {
          if (isNearBottomRef.current) {
            setTimeout(() => scrollToBottom(true), 50);
          } else {
            setHasUnreadBelow(true);
          }
        }
        return merged;
      });

      setChatError("");
      setChatUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (error) {
      if (loadId === chatLoadIdRef.current) {
        setChatError(error instanceof Error ? error.message : "Room messages could not be loaded.");
      }
    } finally {
      if (loadId === chatLoadIdRef.current) setChatLoading(false);
    }
  }, [room, scrollToBottom]);

  useEffect(() => {
    if (currentRoomRef.current !== room) {
      currentRoomRef.current = room;
      setChatMessages([]);
      if (roomReady && activeMode === "chat") {
        void loadChat(false, true);
        setTimeout(() => scrollToBottom(false), 100);
      }
    }
  }, [activeMode, loadChat, room, roomReady, scrollToBottom]);

  useEffect(() => {
    if (activeMode !== "chat" || !roomReady) return;
    void loadChat(true, false);
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadChat(true, false);
    }, 6000);
    return () => window.clearInterval(interval);
  }, [activeMode, loadChat, roomReady]);

  function readStoredBackup() {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) throw new Error("No local TRACE/CORE vault found in this browser.");
    return parseIdentityBackup(JSON.parse(raw));
  }

  function hydrateBackup(backup: IdentityBackup, unlockedSeed: Uint8Array) {
    setSeed(unlockedSeed);
    setVault(backup.vault);
    setDid(backup.vault.did);
    setMailbox(backup.profile.mailbox || createMailboxName());
    setXHandle(backup.profile.xHandle);
    setProfileUrl(backup.profile.profileUrl);
    setActivity(backup.activity);
    setProofRecord(backup.lastProof);
    setProof(backup.lastProof ? { contributionUrl: backup.lastProof.contribution.url, description: backup.lastProof.contribution.description } : INITIAL_PROOF);
    setCreatedAt(backup.createdAt);
    setPassword("");
    setReplaceArmed(false);
    setPendingImport(null);
    setActiveMode("chat");
  }

  async function onCreateIdentity() {
    if (password.length < 8) {
      setFeedback({ ok: false, text: "Please enter a vault password of at least 8 characters." });
      return;
    }
    await run("identity", async () => {
      if (storedVaultAvailable && !replaceArmed) {
        setReplaceArmed(true);
        log("IDENTITY", "Existing vault protected. Confirm replacement to generate a new DID.", false);
        return;
      }
      const identity = await createIdentity();
      const encrypted = await encryptSeed(identity.seed, identity.did, password);
      const now = new Date().toISOString();
      setDid(identity.did);
      setSeed(identity.seed);
      setVault(encrypted);
      setMailbox(createMailboxName());
      setXHandle("");
      setProfileUrl("");
      setActivity(EMPTY_ACTIVITY);
      setProof(INITIAL_PROOF);
      setProofRecord(null);
      setCreatedAt(now);
      setPassword("");
      setReplaceArmed(false);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: "New identity generated and encrypted locally. You can now use chat." });
      setActiveMode("chat");
      log("IDENTITY", `${identity.did} · encrypted locally · portable backup v2`);
    });
  }

  async function onUnlock() {
    if (!password) {
      setFeedback({ ok: false, text: "Please enter your vault password." });
      return;
    }
    await run("unlock", async () => {
      const backup = readStoredBackup();
      hydrateBackup(backup, await unlockBackupSeed(backup, password));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: "Local identity unlocked! Profile, mailbox and history restored." });
      log("UNLOCK", "Identity, mailbox, profile and proof history restored for this session.");
    });
  }

  async function onUnlockPendingImport() {
    if (!pendingImport) return;
    if (!password) {
      setFeedback({ ok: false, text: "Please enter the password for this backup file." });
      return;
    }
    await run("import", async () => {
      hydrateBackup(pendingImport, await unlockBackupSeed(pendingImport, password));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: `Backup verified and restored: ${shortIdentity(pendingImport.vault.did)}` });
      log("IMPORT", `${pendingImport.vault.did} · backup verified and restored`);
    });
  }

  async function onImportVault(file: File | undefined) {
    if (!file) return;
    await run("import", async () => {
      if (file.size > 128_000) throw new Error("Backup file is unexpectedly large.");
      const backup = parseIdentityBackup(JSON.parse(await file.text()));
      if (password) {
        try {
          hydrateBackup(backup, await unlockBackupSeed(backup, password));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          setFeedback({ ok: true, text: `Backup verified and restored: ${shortIdentity(backup.vault.did)}` });
          log("IMPORT", `${backup.vault.did} · backup verified and restored`);
          return;
        } catch {
          // If current typed password fails, keep pendingImport so user can enter the correct password
        }
      }
      setPendingImport(backup);
      setFeedback({ ok: false, text: `Backup loaded for ${shortIdentity(backup.vault.did)}. Enter its password to decrypt.` });
    });
  }

  function chooseBackup() {
    fileInputRef.current?.click();
  }

  function onLockSession() {
    setSeed(null);
    setPassword("");
    setFeedback({ ok: true, text: "Session locked. Private key cleared from memory." });
    setActiveMode("start");
  }

  function updateProfileField(field: "xHandle" | "profileUrl", value: string) {
    if (field === "xHandle") setXHandle(value); else setProfileUrl(value);
    setActivity((current) => ({ ...current, profilePublishedAt: null }));
  }

  function regenerateMailbox() {
    setMailbox(createMailboxName());
    setActivity((current) => ({ ...current, profilePublishedAt: null }));
  }

  async function onPublishProfile() {
    await run("profile", async () => {
      if (!did || !profileReady) throw new Error("Please check the mailbox, X handle and valid HTTPS profile URL.");
      const fp = await didFingerprint(did);
      const ns = `did-${fp.slice(0, 2)}`;
      const key = fp.slice(2);
      const value = [
        did,
        `mailbox: ${mailbox}`,
        xHandle.trim() ? `x: ${xHandle.trim().replace(/^@/, "")}` : "",
        profileUrl.trim() ? `profile: ${profileUrl.trim()}` : "",
        "tool: TRACE/CORE",
        "flop_stage: pre-testnet",
        "proof_schema: trace-core.contribution-proof/v1",
      ].filter(Boolean).join(" | ");
      if (codePointLength(value) > 8192) throw new Error("Profile note exceeds Technocore's 8192-character limit.");
      await technocore(`/kv/${ns}/${key}`, "POST", { value });
      setActivity((current) => ({ ...current, profilePublishedAt: new Date().toISOString() }));
      setFeedback({ ok: true, text: "Profile note published to Technocore network and stored in your encrypted vault." });
      log("PROFILE", `/kv/${ns}/${key} · published`);
    });
  }

  async function sendSigned(targetRoom: string, rawText: string, label = "SIGNED") {
    if (!seed || !did) throw new Error("Unlock your local identity first.");
    if (!NAME_PATTERN.test(targetRoom)) throw new Error("Room name contains invalid characters.");
    const cleanText = sweepSingleLine(rawText);
    const length = codePointLength(cleanText);
    if (!cleanText || length > 4096) throw new Error("Signed message must contain 1–4096 characters.");

    const execute = async () => {
      const nonce = nextRoomNonce(did, targetRoom);
      const signed = await signRoomMessage(seed, targetRoom, nonce, cleanText);
      if (!await verifyRoomMessage(did, targetRoom, nonce, signed.text, signed.sig)) {
        throw new Error("Local signature verification failed; nothing was sent.");
      }
      const result = await technocore(`/r/${targetRoom}?format=json`, "POST", { did, sig: signed.sig, nonce, text: signed.text });
      const receipt = extractReceipt(result, did, nonce);
      log(label, receipt ? `seq #${receipt.seq} · ${targetRoom} · signature verified` : `${targetRoom} · accepted by Technocore`);
      return { nonce, signed, receipt };
    };

    if ("locks" in navigator) return navigator.locks.request(`trace-core-sign:${did}:${targetRoom}`, execute);
    return execute();
  }

  async function onSendSigned() {
    if (!signalReady || !message.trim()) return;
    const pendingText = message;
    setMessage("");

    const tempSeq = Date.now();
    const optimisticMessage: ChatMessage = {
      seq: tempSeq,
      ts: new Date().toISOString(),
      from: did,
      text: pendingText,
      nonce: 0,
      pending: true,
    };
    setChatMessages((prev) => [...prev, optimisticMessage]);
    setTimeout(() => scrollToBottom(true), 20);

    await run("signed", async () => {
      try {
        const sent = await sendSigned(room, pendingText, "CHAT");
        setActivity((current) => ({ ...current, signedMessageAt: new Date().toISOString() }));
        setFeedback({ ok: true, text: "Signed message broadcast to Technocore room." });
        
        setChatMessages((prev) => prev.filter((m) => m.seq !== tempSeq));
        if (sent.receipt) {
          const confirmedMessage: ChatMessage = {
            seq: sent.receipt.seq,
            ts: sent.receipt.ts,
            from: sent.receipt.from,
            text: sent.receipt.text,
            nonce: sent.receipt.nonce,
          };
          setChatMessages((prev) => {
            const map = new Map<number, ChatMessage>();
            for (const item of prev) map.set(item.seq, item);
            map.set(confirmedMessage.seq, confirmedMessage);
            return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
          });
        }
        void loadChat(true, false);
      } catch (err) {
        setChatMessages((prev) => prev.filter((m) => m.seq !== tempSeq));
        setMessage(pendingText);
        throw err;
      }
    });
  }

  function updateProof(next: Partial<ProofInput>) { setProof((current) => ({ ...current, ...next })); }

  async function onRecordProof() {
    await run("proof", async () => {
      if (!contributionReady) throw new Error("Please enter a valid public HTTPS URL and 1–512 character description.");
      const contributionUrl = proof.contributionUrl.trim();
      const description = sweepSingleLine(proof.description);
      const sent = await sendSigned("technocore", `contribution: ${contributionUrl} | ${description} | built with TRACE/CORE for the FLOP ecosystem`, "PROOF");
      const fp = await didFingerprint(did);
      const recordedAt = new Date().toISOString();
      const record: ContributionProofRecord = {
        schema: "trace-core.contribution-proof/v1",
        generated_at: recordedAt,
        context: { network: "FLOP", stage: "pre-testnet", service: "Technocore", eligibility_claim: "none" },
        identity: { did, mailbox, profile_note_path: `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}` },
        contribution: { url: contributionUrl, description },
        signed_message: { room: "technocore", nonce: sent.nonce, text: sent.signed.text, signature: sent.signed.sig, payload: sent.signed.payload, signature_verified_locally: true },
        technocore_receipt: sent.receipt,
        verification: { algorithm: "Ed25519", did_method: "did:key", signed_bytes: "UTF-8(room|nonce|single-line-text)" },
        sources: SOURCES,
        warning: "Technocore evidence is not FLOP testnet activity and does not guarantee eligibility or allocation.",
      };
      setProofRecord(record);
      setActivity((current) => ({ ...current, proofRecordedAt: recordedAt }));
      setFeedback({ ok: true, text: "Signed contribution recorded. You can now export your public proof." });
      log("PROOF", "Contribution proof recorded with verifiable signature.");
    });
  }

  async function onExportProof() {
    await run("export", async () => {
      if (!proofRecord) throw new Error("Record a signed contribution first before exporting.");
      downloadJson("trace-core-public-proof.json", proofRecord);
      log("EXPORT", "Verifiable public proof JSON downloaded.");
    });
  }

  function onExportVault() {
    if (!vault || !createdAt) return log("VAULT", "Create or unlock an identity first.", false);
    downloadJson("trace-core-identity-backup.json", createIdentityBackup(vault, { mailbox, xHandle, profileUrl }, activity, proofRecord, createdAt));
    log("VAULT", "Encrypted portable backup downloaded.");
  }

  const heroTitle = activeMode === "start" ? <>ONE KEY.<br/><em>YOUR AGENT.</em></>
    : activeMode === "chat" ? <>SIGNED CHAT.<br/><em>LIVE ROOM.</em></>
    : activeMode === "profile" ? <>PUBLIC SIGNAL.<br/><em>LOCAL KEY.</em></>
    : <>USEFUL WORK.<br/><em>PORTABLE PROOF.</em></>;

  return <main>
    <header className="topbar shell">
      <div className="brand">TRACE<span>/</span>CORE</div>
      <div className="topmeta">UNOFFICIAL FLOP ECOSYSTEM UTILITY · LOCAL-FIRST</div>
      <nav className="toplinks" aria-label="Official references">
        <a href="https://github.com/yusufky63/trace-core" target="_blank" rel="noreferrer">GITHUB ↗</a>
        <a href="https://x.com/codexsha" target="_blank" rel="noreferrer">@CODEXSHA ↗</a>
      </nav>
    </header>

    <section className="hero compactHero shell grid12">
      <div className="heroKicker">IDENTITY / SIGNED CHAT / PROFILE / VERIFIABLE PROOF</div>
      <h1>{heroTitle}</h1>
      <div className="heroAside">
        <p>Your private seed never leaves your browser. Send verifiable signed messages in live Technocore rooms.</p>
        <div className="progress" aria-label={`${progress}% pre-testnet trail complete`}><span style={{ width: `${progress}%` }} /></div>
        <div className="progressLabel"><b>{progress}%</b><span>PRE-TESTNET TRAIL</span></div>
      </div>
    </section>

    <nav className="modeBar shell" role="tablist" aria-label="TRACE CORE workspace">
      {MODES.map((mode) => (
        <button
          key={mode.id}
          id={`tab-${mode.id}`}
          role="tab"
          aria-selected={activeMode === mode.id}
          aria-controls={`mode-${mode.id}`}
          className={activeMode === mode.id ? "active" : ""}
          onClick={() => setActiveMode(mode.id)}
        >
          <span>{mode.number}</span>{mode.label}
        </button>
      ))}
    </nav>

    <section className="shell focusWorkspace">
      <div className="focusMain">
        {feedback && (
          <div className={`feedbackBanner ${feedback.ok ? "success" : "error"}`} role={feedback.ok ? "status" : "alert"}>
            <p>{feedback.text}</p>
            <button onClick={() => setFeedback(null)} aria-label="Dismiss notification">DISMISS</button>
          </div>
        )}

        {/* MODE 1: START / IDENTITY */}
        {activeMode === "start" && (
          <ModePanel id="start" title="IDENTITY VAULT" eyebrow="Local-First Vault & DID" tabId="tab-start">
            {/* STATE 0: PENDING IMPORT UNLOCK */}
            {pendingImport ? (
              <div className="vaultCard highlight">
                <div className="vaultCardHead">
                  <span>DECRYPT IMPORTED BACKUP</span>
                  <b>{shortIdentity(pendingImport.vault.did)}</b>
                </div>
                <p className="notice">
                  Selected backup file is ready. Enter the password you used when creating this backup file to decrypt and restore it.
                </p>
                <form onSubmit={(e) => { e.preventDefault(); void onUnlockPendingImport(); }}>
                  <Field label="Backup Password" hint="Password for this JSON file">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      autoFocus
                    />
                  </Field>
                  <div className="buttonRow" style={{ marginTop: "14px" }}>
                    <button type="submit" className="primary" disabled={!!busy || !password}>
                      {busy === "import" ? "DECRYPTING..." : "DECRYPT & RESTORE"}
                    </button>
                    <button type="button" onClick={() => setPendingImport(null)}>CANCEL</button>
                  </div>
                </form>
              </div>
            ) : seed && did ? (
              /* STATE 1: UNLOCKED ACTIVE SESSION */
              <div className="vaultActiveBanner">
                <div className="vaultActiveHead">
                  <span /> SESSION ACTIVE — IDENTITY UNLOCKED
                </div>
                <CodeValue label="ACTIVE DID" value={did} />
                <div className="buttonRow">
                  <button className="primary" onClick={() => setActiveMode("chat")}>OPEN CHAT ↗</button>
                  <button onClick={() => setActiveMode("profile")}>PROFILE SETTINGS</button>
                  <button onClick={onExportVault}>EXPORT BACKUP (JSON)</button>
                  <button onClick={onLockSession}>LOCK SESSION</button>
                </div>
                <p className="micro">Your private key is loaded in memory for this session. It remains encrypted in your local browser vault.</p>
              </div>
            ) : storedVaultAvailable ? (
              /* STATE 2: PROTECTED LOCAL VAULT FOUND (LOCKED) */
              <div className="vaultCard highlight">
                <div className="vaultCardHead">
                  <span>PROTECTED LOCAL VAULT FOUND</span>
                  <b>LOCKED</b>
                </div>
                <p className="notice">
                  An encrypted identity is stored in this browser. Enter your password to unlock your <strong>DID, linked profile handles, mailbox, and contribution history</strong> automatically. No need to re-import JSON each time.
                </p>
                <form onSubmit={(e) => { e.preventDefault(); void onUnlock(); }}>
                  <Field label="Vault Password" hint="Password used when creating this vault">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      autoComplete="current-password"
                      autoFocus
                    />
                  </Field>
                  <div className="buttonRow" style={{ marginTop: "14px" }}>
                    <button type="submit" className="primary" disabled={!!busy || !password}>
                      {busy === "unlock" ? "UNLOCKING..." : "UNLOCK LOCAL VAULT"}
                    </button>
                  </div>
                </form>

                <details style={{ marginTop: "12px", borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
                  <summary style={{ cursor: "pointer", font: "900 9px ui-monospace, monospace", color: "var(--muted)" }}>
                    OTHER ACTIONS (IMPORT BACKUP OR CREATE NEW DID)
                  </summary>
                  <div style={{ marginTop: "14px", display: "grid", gap: "10px" }}>
                    <div className="buttonRow">
                      <button onClick={chooseBackup} disabled={!!busy}>IMPORT DIFFERENT JSON BACKUP</button>
                      <button onClick={onCreateIdentity} disabled={!!busy} className={replaceArmed ? "primary" : ""}>
                        {replaceArmed ? "CONFIRM NEW DID REPLACEMENT" : "CREATE NEW DID (RESET)"}
                      </button>
                      {replaceArmed && <button onClick={() => setReplaceArmed(false)}>CANCEL</button>}
                    </div>
                    {replaceArmed && <p className="notice danger">Replacing your identity will overwrite the local vault. Make sure you exported your current backup first.</p>}
                  </div>
                </details>
              </div>
            ) : (
              /* STATE 3: FIRST TIME USER (NO VAULT) */
              <div className="vaultCard">
                <div className="vaultCardHead">
                  <span>GET STARTED</span>
                  <b>NO VAULT FOUND</b>
                </div>
                <p className="notice">
                  No local vault found in this browser. Create a new Ed25519 `did:key` identity or import an existing encrypted backup JSON.
                </p>
                <Field label="Choose Vault Password" hint="At least 8 characters · used for in-browser PBKDF2/AES encryption">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete="new-password"
                  />
                </Field>
                <div className="buttonRow">
                  <button className="primary" onClick={onCreateIdentity} disabled={!!busy || password.length < 8}>
                    {busy === "identity" ? "CREATING..." : "CREATE NEW DID"}
                  </button>
                  <button onClick={chooseBackup} disabled={!!busy}>
                    IMPORT BACKUP JSON
                  </button>
                </div>
              </div>
            )}

            <input
              ref={fileInputRef}
              className="hiddenFile"
              type="file"
              accept="application/json,.json"
              aria-label="Import encrypted identity backup"
              onChange={(event) => {
                void onImportVault(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </ModePanel>
        )}

        {/* MODE 2: SIGNED CHAT */}
        {activeMode === "chat" && (
          <ModePanel id="chat" title="SIGNED CHAT" eyebrow="Technocore Live Rooms" tabId="tab-chat" wide>
            <div className={`chatContainer ${isChatFullscreen ? "fullscreenMode" : ""}`}>
              {/* Row 1: Room Selector & Action Buttons */}
              <div className="chatToolbar">
                <div className="roomInputWrap">
                  <span className="roomPrefix">/r/</span>
                  <input
                    value={room}
                    onChange={(e) => setRoom(e.target.value.toLowerCase().trim())}
                    maxLength={48}
                    aria-invalid={!roomReady}
                    placeholder="room-name"
                  />
                </div>
                
                <div className="chatToolbarActions">
                  <button
                    type="button"
                    className="syncBtn"
                    onClick={() => void loadChat(false, false)}
                    disabled={chatLoading || !roomReady}
                    title="Synchronize room messages"
                  >
                    <svg className={`syncIcon ${chatLoading ? "spinning" : ""}`} viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    <span>{chatLoading ? "SYNCING..." : "SYNC"}</span>
                  </button>

                  <button
                    type="button"
                    className="expandChatBtn"
                    onClick={() => setIsChatFullscreen((v) => !v)}
                    title={isChatFullscreen ? "Exit Fullscreen (Esc)" : "Expand to Fullscreen"}
                  >
                    {isChatFullscreen ? "🗗 EXIT" : "⛶ FULLSCREEN"}
                  </button>
                </div>
              </div>

              {/* Row 2: Dedicated Quick Room Chips */}
              <div className="chatPillsRow" aria-label="Quick room selection">
                <span className="pillsLabel">ROOMS:</span>
                <div className="quickRooms">
                  <button className={room === "lobby" ? "active" : ""} onClick={() => setRoom("lobby")}>#lobby</button>
                  <button className={room === "technocore" ? "active" : ""} onClick={() => setRoom("technocore")}>#technocore</button>
                  <button className={room === "events" ? "active" : ""} onClick={() => setRoom("events")}>#events</button>
                  {MAILBOX_PATTERN.test(mailbox) && (
                    <button className={room === mailbox ? "active" : ""} onClick={() => setRoom(mailbox)}>#my-mailbox</button>
                  )}
                </div>
              </div>

              {/* Row 3: Unified Filters + Search + Compact Live Status */}
              <div className="chatControlBar">
                <div className="chatFiltersGroup" role="group" aria-label="Message filters">
                  {(["all", "signed", "mine"] as ChatFilter[]).map((filter) => (
                    <button
                      key={filter}
                      className={chatFilter === filter ? "active" : ""}
                      onClick={() => setChatFilter(filter)}
                      disabled={filter === "mine" && !did}
                    >
                      {filter === "all" ? "ALL" : filter === "signed" ? "SIGNED ONLY" : "MY MESSAGES"}
                    </button>
                  ))}
                </div>

                <div className="chatSearchWrap">
                  <input
                    type="text"
                    value={chatSearch}
                    onChange={(e) => setChatSearch(e.target.value)}
                    placeholder="Search messages or DIDs..."
                  />
                  {chatSearch && (
                    <button className="clearSearch" onClick={() => setChatSearch("")} aria-label="Clear search">✕</button>
                  )}
                </div>

                <div className="chatStatusPill" title={chatUpdatedAt ? `Last synchronized at ${chatUpdatedAt}` : "Connecting..."}>
                  <span className="liveDot" />
                  <span className="pillMsgs">{visibleMessages.length} msgs</span>
                  <span className="pillTime">{chatUpdatedAt || "connecting"}</span>
                </div>
              </div>

              {chatError && <p className="notice danger" role="alert">{chatError}</p>}

              {/* Chat Feed (Taller, High contrast, Responsive) */}
              <div className="chatFeedContainer">
                <div
                  ref={chatFeedRef}
                  className="chatFeed"
                  onScroll={handleChatScroll}
                  aria-label={`Messages in ${room}`}
                >
                  {chatLoading && chatMessages.length === 0 ? (
                    <div className="chatEmpty">Loading room messages...</div>
                  ) : visibleMessages.length === 0 ? (
                    <div className="chatEmpty">No messages match this filter.</div>
                  ) : (
                    visibleMessages.map((item) => {
                      const signed = isSignedMessage(item);
                      const mine = !!did && item.from === did;
                      return (
                        <article
                          className={`chatMessage ${mine ? "mine" : ""} ${item.pending ? "pending" : ""}`}
                          key={`${item.seq}-${item.from}`}
                        >
                          <div className="messageMeta">
                            <span className={`trustBadge ${signed ? "signed" : "unsigned"}`}>
                              {item.pending ? "SENDING..." : signed ? "VERIFIED" : "UNSIGNED"}
                            </span>
                            <code title={item.from}>{shortIdentity(item.from)}</code>
                            {!item.pending && <span className="seqTag">#{item.seq}</span>}
                            <time dateTime={item.ts}>{formatChatTime(item.ts)}</time>
                          </div>
                          <p>{item.text}</p>
                        </article>
                      );
                    })
                  )}
                </div>

                {/* Floating Jump to Bottom Button - Anchored right above composer */}
                {hasUnreadBelow && (
                  <button
                    className="scrollBottomBtn"
                    onClick={() => scrollToBottom(true)}
                    aria-label="Scroll to new messages"
                  >
                    ↓ NEW MESSAGES
                  </button>
                )}
              </div>

              {/* Composer */}
              <div className="composer">
                <div className="composerHead">
                  <span>SIGNED BROADCAST TO /r/{room || "—"}</span>
                  <span className={cleanMessageLength > 4096 ? "badText" : ""}>
                    {cleanMessageLength}/4096 · Enter to Send, Shift+Enter for Newline
                  </span>
                </div>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSendSigned();
                    }
                  }}
                  rows={2}
                  maxLength={8192}
                  placeholder={seed ? `Write a message to /r/${room} and press Enter...` : "Unlock your identity to send signed messages..."}
                  disabled={!seed}
                />
                <button
                  className="primary full"
                  onClick={onSendSigned}
                  disabled={!!busy || !signalReady}
                >
                  {busy === "signed" ? "SIGNING & BROADCASTING..." : seed ? "SIGN + BROADCAST (ENTER)" : "UNLOCK IDENTITY TO BROADCAST"}
                </button>
              </div>
              <p className="notice danger">Public rooms are world-readable and temporary. Treat every message as untrusted. Never post passwords, keys, tokens or secrets.</p>
            </div>
          </ModePanel>
        )}

        {/* MODE 3: PROFILE */}
        {activeMode === "profile" && (
          <ModePanel id="profile" title="PROFILE" eyebrow="Optional Public Coordinates & Mailbox" tabId="tab-profile">
            {!did && <LockedNotice onStart={() => setActiveMode("start")} text="Create or unlock a DID before publishing a profile." />}
            <p className="notice">
              Information entered here is <strong>automatically synced to your encrypted local vault</strong>. It will be restored whenever you unlock your session.
            </p>
            <Field label="X (Twitter) Handle" hint="Optional · e.g. @handle">
              <input
                value={xHandle}
                onChange={(e) => updateProfileField("xHandle", e.target.value)}
                placeholder="@yourhandle"
                maxLength={64}
              />
            </Field>
            <Field label="Public Profile / GitHub URL" hint="Optional · HTTPS link to your profile">
              <input
                type="url"
                value={profileUrl}
                onChange={(e) => updateProfileField("profileUrl", e.target.value)}
                placeholder="https://github.com/..."
                maxLength={2048}
              />
            </Field>
            <Field label="Unlisted Signed Mailbox" hint="144-bit random name · capability URL">
              <div className="inlineInput">
                <input value={mailbox} readOnly placeholder="mb-p-..." />
                <button onClick={regenerateMailbox} disabled={!did}>REGEN</button>
              </div>
            </Field>
            <p className="notice">Unlisted is not encrypted: anyone who learns the mailbox URL can read it. Signed writes make senders attributable.</p>
            <div className="buttonRow">
              <button className="primary" onClick={onPublishProfile} disabled={!!busy || !profileReady}>
                {busy === "profile" ? "PUBLISHING..." : "PUBLISH PROFILE NOTE"}
              </button>
              <button onClick={() => setActiveMode("proof")} disabled={!did}>CONTINUE TO PROOF ↗</button>
            </div>
          </ModePanel>
        )}

        {/* MODE 4: PROOF */}
        {activeMode === "proof" && (
          <ModePanel id="proof" title="PROOF" eyebrow="Record Verifiable Public Work" tabId="tab-proof">
            {!did && <LockedNotice onStart={() => setActiveMode("start")} text="Create or unlock a DID before recording signed evidence." />}
            <Field label="Public Contribution URL" hint="Required · HTTPS only (e.g. GitHub PR / Repo)">
              <input
                type="url"
                value={proof.contributionUrl}
                onChange={(e) => updateProof({ contributionUrl: e.target.value })}
                placeholder="https://github.com/user/project"
                maxLength={2048}
              />
            </Field>
            <Field label="What is useful about it?" hint="Required · max 512 characters">
              <textarea
                rows={3}
                maxLength={512}
                value={proof.description}
                onChange={(e) => updateProof({ description: e.target.value })}
                placeholder="Built a useful Technocore tool for the FLOP ecosystem..."
              />
            </Field>
            <div className="buttonRow">
              <button
                className="primary"
                onClick={onRecordProof}
                disabled={!!busy || !seed || !contributionReady}
              >
                {busy === "proof" ? "RECORDING..." : "RECORD SIGNED PROOF"}
              </button>
              {!proof.contributionUrl && (
                <button
                  type="button"
                  onClick={() => updateProof({ contributionUrl: "https://github.com/yusufky63/trace-core" })}
                >
                  USE REPO URL
                </button>
              )}
            </div>

            <div className="proofPoster">
              <span>VERIFIABLE PUBLIC TRAIL</span>
              <b>{did ? did.slice(8, 22) : "NO-ID-YET"}</b>
              <i>{proofRecord ? "SIGNED RECORD READY" : contributionReady ? "READY TO RECORD" : "WAITING FOR CONTRIBUTION"}</i>
            </div>
            <button className="primary full" onClick={onExportProof} disabled={!proofRecord}>
              EXPORT VERIFIABLE PROOF (JSON)
            </button>
            <p className="notice danger">Technocore evidence is not FLOP testnet activity and does not guarantee eligibility or allocation.</p>
          </ModePanel>
        )}
      </div>

      {/* Sidebar Status Rail */}
      <aside className="statusRail" aria-label="Identity and activity status">
        <div className="statusTop">
          <span>SESSION</span>
          <b className={seed ? "online" : ""}>{seed ? "UNLOCKED (ONLINE)" : storedVaultAvailable ? "LOCKED" : "NO IDENTITY"}</b>
        </div>
        <div className="identityCard">
          <small>PUBLIC DID</small>
          <code title={did}>{did ? shortIdentity(did) : "—"}</code>
          <small>ACTIVE ROOM</small>
          <strong>/r/{room || "—"}</strong>
        </div>
        <div className="miniProgress"><span style={{ width: `${progress}%` }} /></div>
        <div className="statusTop"><span>TRAIL</span><b>{progress}%</b></div>
        <details className="trailDetails" open>
          <summary>5-STEP TRAIL</summary>
          <Trail done={!!did} n="01" text="Portable DID" />
          <Trail done={!!activity.signedMessageAt} n="02" text="Signed Chat" />
          <Trail done={!!activity.profilePublishedAt} n="03" text="Profile Coordinates" />
          <Trail done={contributionReady} n="04" text="Useful Work" />
          <Trail done={!!proofRecord} n="05" text="Portable Proof" />
        </details>
        <details className="activityDetails" open>
          <summary>ACTIVITY LOG ({logs.length})</summary>
          <div className="logHead"><span>LOCAL EVENTS</span><button onClick={() => setLogs([])}>CLEAR</button></div>
          <div className="logList">
            {logs.length === 0 ? (
              <div className="empty">Actions will appear here.</div>
            ) : (
              logs.map((item, index) => (
                <div className={`log ${item.ok ? "ok" : "bad"}`} key={`${item.at}-${index}`}>
                  <div><b>{item.label}</b><span>{item.at}</span></div>
                  <p>{item.detail}</p>
                </div>
              ))
            )}
          </div>
        </details>
      </aside>
    </section>

    <footer className="shell footer">
      <div className="footerTop">
        <div className="footerBrand">
          <b>TRACE<span>/</span>CORE</b>
          <span>Local-first identity, live signed chat & verifiable proof studio for Technocore.</span>
          <div className="authorCredits">
            Created by <a href="https://x.com/codexsha" target="_blank" rel="noreferrer">@codexsha</a> · <a href="https://github.com/yusufky63/trace-core" target="_blank" rel="noreferrer">GitHub Repo</a>
          </div>
        </div>
        <div className="footerLinksGroup">
          <span>OFFICIAL PROTOCOL & SPEC</span>
          <a href="https://flop.finance/teaser/" target="_blank" rel="noreferrer">FLOP Teaser (Q4 2026 Testnet) ↗</a>
          <a href="https://flop.finance/llms.txt" target="_blank" rel="noreferrer">FLOP Specification ↗</a>
          <a href="https://technocore.chat/llms.txt" target="_blank" rel="noreferrer">Technocore Protocol ↗</a>
          <a href="https://flop.finance/apply/kol" target="_blank" rel="noreferrer">Apply: KOL & Creators Survey ↗</a>
          <a href="https://flop.finance/apply/miner" target="_blank" rel="noreferrer">Apply: GPU Miner ↗</a>
          <a href="https://flop.finance/apply/validator" target="_blank" rel="noreferrer">Apply: Validator Node ↗</a>
        </div>
      </div>
      <div className="footerBottom">
        <p>Technocore is public, world-writable and ephemeral. Never publish seeds, private keys, API keys, passwords or secrets.</p>
      </div>
    </footer>
  </main>;
}

function ModePanel({ id, title, eyebrow, tabId, wide = false, children }: { id: Mode; title: string; eyebrow: string; tabId: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <article id={`mode-${id}`} role="tabpanel" aria-labelledby={tabId} className={`modePanel ${wide ? "wide" : ""}`}>
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </header>
      <div className="modeBody">{children}</div>
    </article>
  );
}

function LockedNotice({ onStart, text }: { onStart: () => void; text: string }) {
  return (
    <div className="lockedNotice">
      <p>{text}</p>
      <button onClick={onStart}>GO TO START / UNLOCK</button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <div><span>{label}</span>{hint && <small>{hint}</small>}</div>
      {children}
    </label>
  );
}

function CodeValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="codeValue">
      <span>{label}</span>
      <code>{value}</code>
      <button onClick={handleCopy}>{copied ? "COPIED ✓" : "COPY"}</button>
    </div>
  );
}

function Trail({ done, n, text }: { done: boolean; n: string; text: string }) {
  return (
    <div className={`trail ${done ? "done" : ""}`}>
      <span>{n}</span>
      <p>{text}</p>
      <i>{done ? "●" : "○"}</i>
    </div>
  );
}

