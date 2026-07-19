/**
 * SMS placeholders — integrate Twilio / Fast2SMS / MSG91 later.
 * Triggered from order status updates (Preparing, Ready).
 */
export async function sendSMS(orderStatus, phone, extra = {}) {
  console.log('[sms:placeholder]', { orderStatus, phone, ...extra });
  // Twilio / Fast2SMS integration goes here
  return { ok: true, placeholder: true };
}

/**
 * Placeholder for click-to-call or automated voice — integrate provider later.
 */
export async function makeCall(phone) {
  console.log('[call:placeholder]', phone);
  return { ok: true, placeholder: true };
}
