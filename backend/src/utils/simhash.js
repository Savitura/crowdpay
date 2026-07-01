const crypto = require('crypto');

function getSimhash(text) {
  if (!text) return '0'.repeat(64);
  const words = text.toLowerCase().match(/\w+/g) || [];
  const v = new Array(64).fill(0);
  for (const word of words) {
    const hash = crypto.createHash('md5').update(word).digest();
    let bitStr = '';
    for (let i = 0; i < 8; i++) {
      bitStr += hash[i].toString(2).padStart(8, '0');
    }
    for (let i = 0; i < 64; i++) {
      if (bitStr[i] === '1') {
        v[i] += 1;
      } else {
        v[i] -= 1;
      }
    }
  }
  let simhash = '';
  for (let i = 0; i < 64; i++) {
    simhash += v[i] > 0 ? '1' : '0';
  }
  return simhash;
}

function simhashSimilarity(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== 64 || hash2.length !== 64) return 0;
  let distance = 0;
  for (let i = 0; i < 64; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return 1 - distance / 64;
}

module.exports = {
  getSimhash,
  simhashSimilarity
};
