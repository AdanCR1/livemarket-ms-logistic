import crypto from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 caracteres claros

export function newPairingCode(): string {
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code; // Ejemplo: 'H7K9P2'
}

export function pairingHash(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}