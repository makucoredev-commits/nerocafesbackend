
import { normalizePhone } from './phone.js';

const templateLanguageOverrides = {
  order_started: process.env.WHATSAPP_TEMPLATE_LANG_ORDER_STARTED,
  order_ready: process.env.WHATSAPP_TEMPLATE_LANG_ORDER_READY,
  order_can: process.env.WHATSAPP_TEMPLATE_LANG_ORDER_CAN,
};

const templateNameOverrides = {
  orderPlaced: process.env.WHATSAPP_TEMPLATE_ON_ORDER_PLACED,
  orderReady: process.env.WHATSAPP_TEMPLATE_ON_ORDER_READY,
  orderCancelled: process.env.WHATSAPP_TEMPLATE_ON_ORDER_CANCELLED,
};

const normalizeLanguageCode = (lang) => {
  if (!lang) return null;
  return String(lang).trim().replace('-', '_');
};

const getTemplateLanguage = (templateName, explicitLang) => {
  const lang = explicitLang ||
    templateLanguageOverrides[templateName] ||
    process.env.WHATSAPP_TEMPLATE_LANG;
  return normalizeLanguageCode(lang) || 'en';
};

// Send template with variables. Caller must ensure the template
// is approved for the connected WhatsApp phone number.
const sendTemplate = async (userPhone, templateName, variables = [], lang) => {
  lang = getTemplateLanguage(templateName, lang);
  console.log(`[WhatsApp DEBUG] Template: ${templateName}, Language: ${lang}`);
  if (!process.env.WHATSAPP_PHONE_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
    console.log('[WhatsApp] Skipped (not configured)');
    return { ok: false, error: 'WhatsApp not configured' };
  }

  const formattedPhone = normalizePhone(userPhone);
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

  console.log(`[WhatsApp API] Sending template "${templateName}" to ${formattedPhone} with variables:`, variables);

  // Build body parameters for template variables
  const bodyParameters = variables.map(v => ({ type: 'text', text: String(v) }));

  const payload = {
    messaging_product: 'whatsapp',
    to: formattedPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        { type: 'body', parameters: bodyParameters }
      ]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data.error?.message || JSON.stringify(data);
      console.error(`[WhatsApp] Failed to send template "${templateName}":`, errMsg);
      return { ok: false, error: errMsg, raw: data };
    }

    console.log(`[WhatsApp] Template "${templateName}" sent successfully:`, data);
    return { ok: true, data };
  } catch (error) {
    console.error(`[WhatsApp] Error sending template "${templateName}":`, error.message || error);
    return { ok: false, error: error.message || error };
  }
};

const formatWhatsAppOrderNo = (orderNo) => `NC-${orderNo}`;

// Send order placed message with customer name, order number, and tracking link
export const sendPaymentSuccessMessage = async (userPhone, customerName, orderNo, orderId, trackingToken) => {
  const templateName = templateNameOverrides.orderPlaced || 'order_ready';
  const trackLink = `${process.env.CLIENT_ORIGIN}/order-track/${orderId}?token=${trackingToken}`;
  return sendTemplate(userPhone, templateName, [customerName, formatWhatsAppOrderNo(orderNo), trackLink]);
};

// Send order ready confirmation message
export const sendOrderReadyMessage = async (userPhone, customerName, orderNo) => {
  const templateName = templateNameOverrides.orderReady || 'order_started';
  return sendTemplate(userPhone, templateName, [customerName, formatWhatsAppOrderNo(orderNo)]);
};

// Send order cancellation message with customer name and order number
export const sendCancellationMessage = async (userPhone, customerName, orderNo) => {
  const templateName = templateNameOverrides.orderCancelled || 'order_can';
  return sendTemplate(userPhone, templateName, [customerName, formatWhatsAppOrderNo(orderNo)]);
};

// Send an approved template with parameters. Caller must ensure the template
// is created and approved for the connected WhatsApp phone number.
export const sendWhatsAppTemplate = async (userPhone, templateName, params = [], lang = 'en_US') => {
  return sendTemplate(userPhone, templateName, params, lang);
};
