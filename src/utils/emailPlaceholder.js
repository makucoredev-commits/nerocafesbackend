import nodemailer from 'nodemailer';
import { createEmailVerificationToken } from './emailVerification.js';
import { logger } from './logger.js';

// Helper to create transport
function getTransporter() {
  const user = process.env.SMTP_USER || 'nerocafes14@gmail.com';
  const pass = process.env.SMTP_PASS;

  if (!pass) {
    return null; // SMTP is not fully configured, log to console instead
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    // Add timeout configuration
    connectionTimeout: 10000, // 10 seconds
    greetingTimeout: 5000, // 5 seconds
    socketTimeout: 10000, // 10 seconds
  });
}

// Master email layout generator — responsive, dark premium NeroCafes branding
function buildEmailTemplate(title, name, contentHtml) {
  const logoUrl = `${process.env.CLIENT_ORIGIN || 'http://localhost:5173'}/logo1.png`;
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <!--[if mso]>
      <noscript>
        <xml>
          <o:OfficeDocumentSettings>
            <o:PixelsPerInch>96</o:PixelsPerInch>
          </o:OfficeDocumentSettings>
        </xml>
      </noscript>
      <![endif]-->
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #02020A;
          color: #FFFDD0;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
          -webkit-text-size-adjust: 100%;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background-color: #05204A;
          border: 1px solid #c9a962;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .header {
          background-color: #02020A;
          text-align: center;
          padding: 30px 20px;
          border-bottom: 2px solid #c9a962;
        }
        .header img {
          max-width: 180px;
          height: auto;
          display: block;
          margin: 0 auto 12px;
        }
        .header h1 {
          color: #c9a962;
          margin: 0;
          font-size: 26px;
          letter-spacing: 2px;
          text-transform: uppercase;
        }
        .content {
          padding: 35px 25px;
          line-height: 1.7;
        }
        .content h2 {
          color: #FFFDD0;
          margin-top: 0;
          font-size: 20px;
        }
        .content p {
          color: #FFFDD0;
          opacity: 0.9;
          font-size: 14px;
          margin: 10px 0;
        }
        .cta-button {
          display: block;
          width: fit-content;
          background-color: #c9a962;
          color: #05204A !important;
          text-decoration: none;
          font-weight: bold;
          padding: 14px 32px;
          border-radius: 30px;
          text-transform: uppercase;
          letter-spacing: 1px;
          font-size: 13px;
          margin: 20px auto;
          text-align: center;
        }
        .info-box {
          background-color: #02020A;
          border: 1px solid rgba(201, 169, 98, 0.3);
          border-radius: 12px;
          padding: 20px;
          margin: 20px 0;
        }
        .info-row {
          display: flex;
          justify-content: space-between;
          padding: 6px 0;
          font-size: 13px;
        }
        .info-label {
          color: rgba(255, 253, 208, 0.6);
        }
        .info-value {
          color: #FFFDD0;
          font-weight: bold;
        }
        .gold { color: #c9a962; }
        .footer {
          background-color: #02020A;
          text-align: center;
          padding: 20px;
          font-size: 11px;
          color: #FFFDD0;
          opacity: 0.5;
          border-top: 1px solid rgba(201, 169, 98, 0.1);
        }
        table.items-table {
          width: 100%;
          border-collapse: collapse;
          margin: 15px 0;
        }
        table.items-table th {
          text-align: left;
          font-size: 11px;
          text-transform: uppercase;
          color: #c9a962;
          border-bottom: 1px solid rgba(201, 169, 98, 0.25);
          padding: 8px 4px;
          letter-spacing: 0.5px;
        }
        table.items-table td {
          padding: 10px 4px;
          font-size: 13px;
          color: #FFFDD0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .status-badge {
          display: inline-block;
          padding: 8px 20px;
          border-radius: 30px;
          font-size: 14px;
          font-weight: bold;
          text-transform: uppercase;
          letter-spacing: 1.5px;
        }
        .muted { opacity: 0.6; font-size: 12px; }
        .divider {
          border: none;
          border-top: 1px dashed rgba(201, 169, 98, 0.2);
          margin: 12px 0;
        }
        @media only screen and (max-width: 620px) {
          .container { margin: 10px; border-radius: 12px; }
          .content { padding: 24px 16px; }
          .header { padding: 20px 16px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${logoUrl}" alt="NeroCafes Logo" />
          <h1>NeroCafes</h1>
        </div>
        <div class="content">
          ${name ? `<h2>Hi ${name},</h2>` : ''}
          ${contentHtml}
        </div>
        <div class="footer">
          &copy; 2026 NeroCafes. All rights reserved. ISTTM Business School, Hyderabad.<br>
          Delivered with taste.
        </div>
      </div>
    </body>
    </html>
  `;
}

// ─── WELCOME EMAIL ──────────────────────────────────────────────
export async function sendWelcomeEmail({ to, name, email, password }) {
  logger.info('EMAIL', `Email Sending: welcome → ${to}`);
  
  const transporter = getTransporter();
  const fromUser = process.env.SMTP_USER || 'nerocafes14@gmail.com';

  let verificationToken = '';
  try {
    verificationToken = await createEmailVerificationToken(email);
  } catch (err) {
    logger.warn('EMAIL', `Failed to create verification token: ${err.message || err}`);
    return { ok: false, error: err.message || 'Verification email request is rate limited. Please wait before requesting another.' };
  }

  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  const accountLink = verificationToken
    ? `${clientOrigin}/auth?token=${verificationToken}&email=${encodeURIComponent(email)}`
    : `${clientOrigin}/auth`;

  const passwordBlock = password
    ? `<div style="margin-bottom: 10px; font-size: 14px;">
        <span class="gold" style="font-weight: bold;">Temporary Password:</span>
        <span style="color: #FFFDD0; font-family: monospace; background-color: rgba(201, 169, 98, 0.15); padding: 4px 12px; border-radius: 8px; margin-left: 8px; border: 1px solid rgba(201, 169, 98, 0.3);">${password}</span>
      </div>`
    : '';

  const html = buildEmailTemplate('Welcome to NeroCafes', name, `
    <p>Your premium customer profile has been successfully registered by our store reception desk. We are delighted to have you as part of our community!</p>
    <p>An online account has been automatically created for you so you can track your live orders, view your customer loyalty points, and place easy web orders.</p>
    
    <div class="info-box">
      <div style="margin-bottom: 10px; font-size: 14px;">
        <span class="gold" style="font-weight: bold;">Username / Email:</span>
        <span style="color: #FFFDD0; font-family: monospace; background-color: rgba(201, 169, 98, 0.15); padding: 4px 12px; border-radius: 8px; margin-left: 8px; border: 1px solid rgba(201, 169, 98, 0.3);">${email}</span>
      </div>
      ${passwordBlock}
    </div>
    
    <p class="muted">* Use the temporary password above on your first login. Please change it immediately after signing in.</p>
    
    <a href="${accountLink}" class="cta-button">Go To My Account →</a>

    <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(201, 169, 98, 0.15);">
      <p class="muted">Or visit directly: <a href="${clientOrigin}" style="color: #c9a962; text-decoration: underline; font-weight: 500;">${clientOrigin}</a></p>
    </div>
  `);

  if (!transporter) {
    logger.error('EMAIL', 'SMTP Verify Failed: Welcome email SMTP not configured');
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    const startTime = Date.now();
    const info = await transporter.sendMail({
      from: `"NeroCafes" <${fromUser}>`,
      to,
      subject: 'Welcome to NeroCafes! 🎉 Your Account is Ready',
      html
    });
    const duration = Date.now() - startTime;
    logger.success('EMAIL', `Email Sent: Welcome email in ${duration}ms to ${to}`, { duration });
    return { ok: true, info };
  } catch (err) {
    logger.error('EMAIL', `Email Failed: Welcome email to ${to}: ${err.message}`, { error: err });
    return { ok: false, error: err.message };
  }
}

// ─── ORDER CONFIRMATION EMAIL ───────────────────────────────────
export async function sendOrderConfirmationEmail({ to, name, orderNo, total, items = [], orderId }) {
  logger.info('EMAIL', `Email Sending: order confirmation → ${to}`);
  const transporter = getTransporter();
  const fromUser = process.env.SMTP_USER || 'nerocafes14@gmail.com';
  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

  let itemsHtml = '';
  if (items && items.length > 0) {
    const rows = items.map(item => `
      <tr>
        <td>${item.name}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: right; color: rgba(255,253,208,0.6);">₹${item.price}</td>
        <td style="text-align: right; font-weight: bold;">₹${item.price * item.quantity}</td>
      </tr>
    `).join('');
    const itemCount = items.reduce((s, i) => s + (i.quantity || 1), 0);
    itemsHtml = `
      <table class="items-table">
        <thead>
          <tr>
            <th style="text-align: left;">Item</th>
            <th style="text-align: center; width: 10%;">Qty</th>
            <th style="text-align: right; width: 20%;">Price</th>
            <th style="text-align: right; width: 20%;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p class="muted" style="text-align: right;">${itemCount} item${itemCount !== 1 ? 's' : ''}</p>
    `;
  }

  const trackingLink = orderId ? `${clientOrigin}/track/${orderId}` : `${clientOrigin}/track`;

  const html = buildEmailTemplate('Order Confirmed', name, `
    <p>Your order <strong class="gold">NC-${orderNo}</strong> has been successfully placed and is now in the kitchen queue!</p>
    
    ${itemsHtml}
    
    <div class="info-box" style="text-align: right; font-size: 15px; font-weight: bold;">
      <div class="info-row">
        <span style="color: rgba(255, 253, 208, 0.6);">Subtotal</span>
        <span style="color: #FFFDD0;">₹${total}</span>
      </div>
      <div class="info-row" style="font-size: 16px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(201, 169, 98, 0.2);">
        <span style="color: #FFFDD0; font-weight: bold;">Grand Total</span>
        <span class="gold" style="font-size: 20px;">₹${total}</span>
      </div>
    </div>
    
    <p style="margin-top: 20px;">You will receive live status updates as your order progresses through the kitchen.</p>
    <a href="${trackingLink}" class="cta-button">🔴 Track Live Order Status</a>

    <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(201, 169, 98, 0.15);">
      <p class="muted">Order ID: NC-${orderNo} · Placed at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p>
    </div>
  `);

  if (!transporter) {
    logger.error('EMAIL', 'SMTP Verify Failed: Order confirmation SMTP not configured');
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    const startTime = Date.now();
    const info = await transporter.sendMail({
      from: `"NeroCafes" <${fromUser}>`,
      to,
      subject: `Order Confirmed: NC-${orderNo} ☕`,
      html
    });
    const duration = Date.now() - startTime;
    logger.success('EMAIL', `Email Sent: Confirmation email in ${duration}ms to ${to}`, { duration });
    return { ok: true, info };
  } catch (err) {
    logger.error('EMAIL', `Email Failed: Confirmation email to ${to}: ${err.message}`, { error: err });
    return { ok: false, error: err.message };
  }
}

// ─── INVOICE / RECEIPT EMAIL ────────────────────────────────────
export async function sendInvoiceEmail({ to, name, orderId, orderNo, total, items = [], discountAmount = 0 }) {
  logger.info('EMAIL', `Email Sending: invoice → ${to}`);
  const transporter = getTransporter();
  const fromUser = process.env.SMTP_USER || 'nerocafes14@gmail.com';
  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

  let itemsHtml = '';
  let subtotal = 0;
  if (items && items.length > 0) {
    const rows = items.map(item => {
      const lineTotal = item.price * item.quantity;
      subtotal += lineTotal;
      return `
        <tr>
          <td>${item.name}</td>
          <td style="text-align: center;">${item.quantity}</td>
          <td style="text-align: right;">₹${item.price}</td>
          <td style="text-align: right; font-weight: bold;">₹${lineTotal}</td>
        </tr>
      `;
    }).join('');
    itemsHtml = `
      <table class="items-table">
        <thead>
          <tr>
            <th>Item</th>
            <th style="text-align: center; width: 10%;">Qty</th>
            <th style="text-align: right; width: 20%;">Rate</th>
            <th style="text-align: right; width: 20%;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }
  if (!subtotal) subtotal = Number(total) || 0;

  const html = buildEmailTemplate('Your Tax Invoice', name, `
    <p>Thank you for ordering with NeroCafes! Here is your official tax invoice for order <strong class="gold">NC-${orderNo || 'Receipt'}</strong>.</p>
    
    ${itemsHtml}
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Subtotal</span>
        <span class="info-value">₹${subtotal}</span>
      </div>
      ${discountAmount > 0 ? `
      <div class="info-row">
        <span class="info-label">Discount</span>
        <span style="color: #ef5350; font-weight: bold;">-₹${discountAmount}</span>
      </div>` : ''}
      <div class="info-row">
        <span class="info-label">GST (5%)</span>
        <span class="info-value">Included</span>
      </div>
      <hr class="divider">
      <div class="info-row" style="font-size: 18px; margin-top: 8px;">
        <span style="color: #FFFDD0; font-weight: bold;">Amount Paid</span>
        <span class="gold" style="font-weight: bold; font-size: 22px;">₹${total}</span>
      </div>
    </div>
    
    <div style="background-color: rgba(201, 169, 98, 0.08); border: 1px solid rgba(201, 169, 98, 0.2); border-radius: 12px; padding: 16px; margin: 20px 0; text-align: center;">
      <p style="margin: 0; font-size: 12px; color: rgba(255, 253, 208, 0.5);">Payment Method</p>
      <p style="margin: 4px 0 0; font-weight: bold; color: #c9a962;">Cash / UPI at Counter</p>
    </div>
    
    <a href="${clientOrigin}/orders" class="cta-button">View Order History</a>

    <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(201, 169, 98, 0.15);">
      <p class="muted">Invoice NC-${orderNo || 'Receipt'} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
      <p class="muted" style="margin-top: 4px; font-size: 10px;">ISTTM Business School, Hyderabad</p>
    </div>
  `);

  if (!transporter) {
    logger.error('EMAIL', 'SMTP Verify Failed: Invoice SMTP not configured');
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    const startTime = Date.now();
    const info = await transporter.sendMail({
      from: `"NeroCafes" <${fromUser}>`,
      to,
      subject: `Your NeroCafes Tax Invoice: NC-${orderNo || 'Receipt'}`,
      html
    });
    const duration = Date.now() - startTime;
    logger.success('EMAIL', `Email Sent: Invoice email in ${duration}ms to ${to}`, { duration });
    return { ok: true, info };
  } catch (err) {
    logger.error('EMAIL', `Email Failed: Invoice email to ${to}: ${err.message}`, { error: err });
    return { ok: false, error: err.message };
  }
}

// ─── ORDER STATUS UPDATE EMAIL ──────────────────────────────────
export async function sendOrderStatusEmail({ to, name, orderNo, status, orderId, reason }) {
  logger.info('EMAIL', `Email Sending: status update → ${to} (${status})`);
  const transporter = getTransporter();
  const fromUser = process.env.SMTP_USER || 'nerocafes14@gmail.com';
  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

  const statusConfig = {
    Confirmed:  { text: 'has been confirmed! We will start preparing it soon.', color: '#66bb6a', bg: 'rgba(102,187,106,0.12)', emoji: '✅', subject: 'Confirmed' },
    Preparing:  { text: 'is now being prepared fresh in the kitchen!', color: '#ffa726', bg: 'rgba(255,167,38,0.12)', emoji: '🍳', subject: 'Preparing' },
    Cooking:    { text: 'is now being cooked to perfection!', color: '#ff7043', bg: 'rgba(255,112,67,0.12)', emoji: '🔥', subject: 'Cooking' },
    Packing:    { text: 'is being packed and almost ready!', color: '#42a5f5', bg: 'rgba(66,165,245,0.12)', emoji: '📦', subject: 'Packing' },
    Ready:      { text: 'is ready for pickup! Come grab it while it\'s hot.', color: '#42a5f5', bg: 'rgba(66,165,245,0.15)', emoji: '☕', subject: 'Ready for Pickup' },
    Completed:  { text: 'has been completed. Thank you for choosing NeroCafes!', color: '#66bb6a', bg: 'rgba(102,187,106,0.12)', emoji: '🎉', subject: 'Completed' },
    Cancelled:  { text: `has been cancelled.${reason ? ` Reason: ${reason}` : ''}`, color: '#ef5350', bg: 'rgba(239,83,80,0.12)', emoji: '❌', subject: 'Cancelled' },
  };

  const cfg = statusConfig[status] || { text: `status is now ${status}.`, color: '#c9a962', bg: 'rgba(201,169,98,0.1)', emoji: '📋', subject: status };

  const html = buildEmailTemplate('Order Status Update', name, `
    <p>Your order <strong class="gold">NC-${orderNo}</strong> ${cfg.text}</p>
    
    <div style="background-color: ${cfg.bg}; border: 1px solid ${cfg.color}40; border-radius: 16px; padding: 32px 24px; margin: 28px 0; text-align: center;">
      <span style="font-size: 48px; display: block; margin-bottom: 12px; line-height: 1;">${cfg.emoji}</span>
      <span class="status-badge" style="background-color: ${cfg.color}25; color: ${cfg.color}; border: 1px solid ${cfg.color}50; font-size: 16px; padding: 12px 28px;">
        ${status}
      </span>
      ${reason ? `<p style="margin-top: 16px; color: rgba(255, 253, 208, 0.7); font-size: 13px;">${reason}</p>` : ''}
    </div>

    ${status !== 'Cancelled' && status !== 'Completed' ? `
    <p style="margin-top: 20px;">Track the live progress of your order in real-time:</p>
    <a href="${clientOrigin}/track/${orderId}" class="cta-button">🔴 Track Live Progress →</a>
    ` : status === 'Completed' ? `
    <p style="margin-top: 20px;">Thank you for choosing NeroCafes! We hope you enjoyed your order.</p>
    <a href="${clientOrigin}/orders" class="cta-button">View Order History</a>
    ` : `
    <a href="${clientOrigin}/menu" class="cta-button">Place New Order</a>
    `}

    <div style="text-align: center; margin-top: 28px; padding-top: 16px; border-top: 1px solid rgba(201, 169, 98, 0.15);">
      <p class="muted">Order NC-${orderNo} · Updated at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p>
    </div>
  `);

  if (!transporter) {
    logger.error('EMAIL', 'SMTP Verify Failed: Order status update SMTP not configured');
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    const startTime = Date.now();
    const info = await transporter.sendMail({
      from: `"NeroCafes" <${fromUser}>`,
      to,
      subject: `Order NC-${orderNo}: ${cfg.subject} ${cfg.emoji}`,
      html
    });
    const duration = Date.now() - startTime;
    logger.success('EMAIL', `Email Sent: Status update email in ${duration}ms to ${to}`, { duration });
    return { ok: true, info };
  } catch (err) {
    logger.error('EMAIL', `Email Failed: Status update email to ${to}: ${err.message}`, { error: err });
    return { ok: false, error: err.message };
  }
}

// ─── PASSWORD RESET EMAIL ───────────────────────────────────────
export async function sendPasswordResetEmail({ to, name, resetLink }) {
  logger.info('EMAIL', `Email Sending: password reset → ${to}`);
  const transporter = getTransporter();
  const fromUser = process.env.SMTP_USER || 'nerocafes14@gmail.com';
  const fallbackUrl = resetLink || `${process.env.CLIENT_ORIGIN || 'http://localhost:5173'}/auth`;

  const html = buildEmailTemplate('Reset Your Password', name, `
    <p>We received a request to reset the password for your NeroCafes account.</p>
    <p>Use the secure button below to choose a new password. This link expires in <strong>5 minutes</strong>.</p>

    <div class="info-box">
      <p style="margin: 0; color: #c9a962; font-weight: bold;">🔒 Secure Reset Link</p>
      <p style="margin: 10px 0 0; font-size: 11px; opacity: 0.5; word-break: break-all;">${fallbackUrl}</p>
    </div>

    <a href="${resetLink}" class="cta-button">Reset Password →</a>

    <p class="muted" style="margin-top: 18px;">This link expires in 5 minutes. If you did not request this, you can safely ignore this email.</p>
    <p class="muted" style="opacity: 0.45;">Security notice: never share this link with anyone.</p>
  `);

  if (!transporter) {
    logger.error('EMAIL', 'SMTP Verify Failed: Password reset SMTP not configured');
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    const startTime = Date.now();
    const info = await transporter.sendMail({
      from: `"NeroCafes" <${fromUser}>`,
      to,
      subject: 'NeroCafes Password Reset Request 🔑',
      html
    });
    const duration = Date.now() - startTime;
    logger.success('EMAIL', `Email Sent: Password reset email in ${duration}ms to ${to}`, { duration });
    return { ok: true, info };
  } catch (err) {
    logger.error('EMAIL', `Email Failed: Password reset email to ${to}: ${err.message}`, { error: err });
    return { ok: false, error: err.message };
  }
}
