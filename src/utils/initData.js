import crypto from 'crypto';

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

export const validateInitData = (initData, botToken) => {
  if (!initData || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const receivedHash = params.get('hash');
  if (!receivedHash) return null;

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const computedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const expected = Buffer.from(computedHash);
  const received = Buffer.from(receivedHash);
  if (expected.length !== received.length) return null;
  if (!crypto.timingSafeEqual(expected, received)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SECONDS) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
};