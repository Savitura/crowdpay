# Constant-time credential verification

API keys retain their existing bcrypt storage format, encrypted-at-rest handling, salts and work factors. Verification recomputes bcrypt using the stored salt and compares complete hash bytes with Node crypto.timingSafeEqual. No key migration or API change is required.

Inbound CrowdPay and Persona webhook SHA-256 signatures require exactly 64 hexadecimal characters before decoding and use timingSafeEqual on 32-byte digests. Invalid suffixes cannot be silently discarded by Node hex decoding. Persona evaluates all supplied rotation signatures. Existing optional CrowdPay sha256= prefixes remain accepted.

These guarantees cover digest comparisons, not the entire HTTP request, database lookup, bcrypt work factors, header parsing or malformed-input rejection. Existing replay and authentication policies are unchanged.
