import * as ed from "@noble/ed25519";
import bs58 from "bs58";

const encoder = new TextEncoder();

export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const MAILBOX_PATTERN = /^mb-p-[a-f0-9]{36}$/;

export type VaultPayload = {
  version: 1;
  did: string;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type IdentityProfile = {
  mailbox: string;
  xHandle: string;
  profileUrl: string;
};

export type IdentityActivity = {
  profilePublishedAt: string | null;
  signedMessageAt: string | null;
  proofRecordedAt: string | null;
};

export type TechnocoreReceipt = {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce: number;
};

export type ContributionProofRecord = {
  schema: "trace-core.contribution-proof/v1";
  generated_at: string;
  context: {
    network: "FLOP";
    stage: "pre-testnet";
    service: "Technocore";
    eligibility_claim: "none";
  };
  identity: {
    did: string;
    mailbox: string;
    profile_note_path: string;
  };
  contribution: {
    url: string;
    description: string;
  };
  signed_message: {
    room: string;
    nonce: string;
    text: string;
    signature: string;
    payload: string;
    signature_verified_locally: true;
  };
  technocore_receipt: TechnocoreReceipt | null;
  verification: {
    algorithm: "Ed25519";
    did_method: "did:key";
    signed_bytes: "UTF-8(room|nonce|single-line-text)";
  };
  sources: string[];
  warning: string;
};

export type IdentityBackup = {
  format: "trace-core.identity-backup";
  version: 2;
  vault: VaultPayload;
  profile: IdentityProfile;
  activity: IdentityActivity;
  lastProof: ContributionProofRecord | null;
  createdAt: string;
  updatedAt: string;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value in vault.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrEmpty(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength ? value : "";
}

function nullableDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function parseVault(value: unknown): VaultPayload {
  if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported identity vault format.");
  const did = value.did;
  const salt = value.salt;
  const iv = value.iv;
  const ciphertext = value.ciphertext;
  if (typeof did !== "string" || !DID_PATTERN.test(did)) throw new Error("Vault contains an invalid Ed25519 DID.");
  if (typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    throw new Error("Vault encryption fields are missing.");
  }
  if (base64UrlToBytes(salt).length !== 16 || base64UrlToBytes(iv).length !== 12 || base64UrlToBytes(ciphertext).length !== 48) {
    throw new Error("Vault encryption fields have invalid lengths.");
  }
  return { version: 1, did, salt, iv, ciphertext };
}

function parseProof(value: unknown, did: string): ContributionProofRecord | null {
  if (!isRecord(value) || value.schema !== "trace-core.contribution-proof/v1") return null;
  const identity = value.identity;
  const contribution = value.contribution;
  const signed = value.signed_message;
  if (!isRecord(identity) || identity.did !== did || !isRecord(contribution) || !isRecord(signed)) return null;
  if (typeof contribution.url !== "string" || typeof contribution.description !== "string") return null;
  if (typeof signed.room !== "string" || typeof signed.nonce !== "string" || typeof signed.text !== "string") return null;
  if (typeof signed.signature !== "string" || typeof signed.payload !== "string") return null;
  return value as ContributionProofRecord;
}

async function deriveVaultKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 210_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function seedToDid(seed: Uint8Array) {
  const publicKey = await ed.getPublicKeyAsync(seed);
  const multicodec = new Uint8Array(2 + publicKey.length);
  multicodec.set([0xed, 0x01], 0);
  multicodec.set(publicKey, 2);
  return `did:key:z${bs58.encode(multicodec)}`;
}

export async function createIdentity() {
  const seed = randomBytes(32);
  const did = await seedToDid(seed);
  return { seed, did };
}

export async function encryptSeed(seed: Uint8Array, did: string, password: string): Promise<VaultPayload> {
  if (password.length < 8) throw new Error("Use at least 8 characters for the local vault password.");
  if (!DID_PATTERN.test(did)) throw new Error("Cannot encrypt an invalid Ed25519 DID.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveVaultKey(password, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, seed as BufferSource);
  return {
    version: 1,
    did,
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function decryptSeed(vaultInput: VaultPayload, password: string) {
  const vault = parseVault(vaultInput);
  const salt = base64UrlToBytes(vault.salt);
  const iv = base64UrlToBytes(vault.iv);
  const key = await deriveVaultKey(password, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    base64UrlToBytes(vault.ciphertext) as BufferSource
  );
  const seed = new Uint8Array(decrypted);
  const did = await seedToDid(seed);
  if (did !== vault.did) throw new Error("Vault integrity check failed.");
  return seed;
}

export async function signRoomMessage(seed: Uint8Array, room: string, nonce: string, text: string) {
  const cleanText = sweepSingleLine(text);
  const payload = `${room}|${nonce}|${cleanText}`;
  const sig = await ed.signAsync(encoder.encode(payload), seed);
  return { text: cleanText, sig: bytesToBase64Url(sig), payload };
}

export async function verifyRoomMessage(did: string, room: string, nonce: string, text: string, signature: string) {
  if (!DID_PATTERN.test(did) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const decoded = bs58.decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return false;
  return ed.verifyAsync(base64UrlToBytes(signature), encoder.encode(`${room}|${nonce}|${sweepSingleLine(text)}`), decoded.slice(2));
}

export async function didFingerprint(did: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(did)));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function sweepSingleLine(text: string) {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function codePointLength(text: string) {
  return Array.from(text).length;
}

export function createMailboxName() {
  const bytes = randomBytes(18);
  return `mb-p-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createIdentityBackup(
  vault: VaultPayload,
  profile: IdentityProfile,
  activity: IdentityActivity,
  lastProof: ContributionProofRecord | null,
  createdAt = new Date().toISOString()
): IdentityBackup {
  return {
    format: "trace-core.identity-backup",
    version: 2,
    vault: parseVault(vault),
    profile,
    activity,
    lastProof,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function parseIdentityBackup(value: unknown): IdentityBackup {
  const legacyVault = isRecord(value) && value.version === 1 && "ciphertext" in value ? parseVault(value) : null;
  if (legacyVault) {
    const now = new Date().toISOString();
    return createIdentityBackup(
      legacyVault,
      { mailbox: "", xHandle: "", profileUrl: "" },
      { profilePublishedAt: null, signedMessageAt: null, proofRecordedAt: null },
      null,
      now
    );
  }
  if (!isRecord(value) || value.format !== "trace-core.identity-backup" || value.version !== 2) {
    throw new Error("Unsupported TRACE/CORE backup format.");
  }
  const vault = parseVault(value.vault);
  const rawProfile = isRecord(value.profile) ? value.profile : {};
  const mailbox = stringOrEmpty(rawProfile.mailbox, 48);
  if (mailbox && !MAILBOX_PATTERN.test(mailbox)) throw new Error("Backup contains an invalid private mailbox name.");
  const profile: IdentityProfile = {
    mailbox,
    xHandle: stringOrEmpty(rawProfile.xHandle, 64),
    profileUrl: stringOrEmpty(rawProfile.profileUrl, 2048),
  };
  const rawActivity = isRecord(value.activity) ? value.activity : {};
  const activity: IdentityActivity = {
    profilePublishedAt: nullableDate(rawActivity.profilePublishedAt),
    signedMessageAt: nullableDate(rawActivity.signedMessageAt),
    proofRecordedAt: nullableDate(rawActivity.proofRecordedAt),
  };
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    ? value.createdAt
    : new Date().toISOString();
  return {
    format: "trace-core.identity-backup",
    version: 2,
    vault,
    profile,
    activity,
    lastProof: parseProof(value.lastProof, vault.did),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

export function nextRoomNonce(did: string, room: string) {
  const storageKey = "trace-core-nonces-v1";
  let state: Record<string, number> = {};
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) state = JSON.parse(raw) as Record<string, number>;
  } catch {
    state = {};
  }
  const key = `${did}|${room}`;
  const previous = Number.isSafeInteger(state[key]) ? state[key] : 0;
  const next = Math.max(Date.now(), previous + 1);
  state[key] = next;
  localStorage.setItem(storageKey, JSON.stringify(state));
  return next.toString();
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
