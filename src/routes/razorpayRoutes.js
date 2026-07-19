import { Router } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { sendPaymentSuccessMessage } from '../utils/whatsapp.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';

const router = Router();

/* ── Create Razorpay Order (user-only) ────────────────────────── */
router.post('/create-order', paymentLimiter, authUser, requireUser, async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: Math.round(amount * 100),
      currency,
      receipt: receipt || `order_${Date.now()}`,
    };

    const order = await instance.orders.create(options);
    if (!order) return res.status(500).json({ error: 'Could not create Razorpay order' });

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Verify Razorpay Payment ──────────────────────────────────── */
router.post('/verify', paymentLimiter, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification fields' });
    }

    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      return res.status(400).json({ msg: 'Transaction not legit!' });
    }

    if (order_id) {
      const order = await Order.findById(order_id);
      if (order) {
        order.paymentStatus = 'Completed';
        order.paymentMeta = { razorpay_order_id, razorpay_payment_id };
        await order.save();

        /* Notify admin via socket */
        const io = req.app.get('io');
        io?.emit('orders:update', { type: 'payment', orderId: order._id, paymentStatus: 'Completed' });

        let targetPhone = order.customer?.phone;
        if (order.userId) {
          const user = await User.findById(order.userId);
          if (user?.phone) targetPhone = user.phone;
        }

        if (targetPhone) {
          sendPaymentSuccessMessage(targetPhone, order.customer?.name || 'Customer', order.orderNo, order._id, order.trackingToken);
        }
      }
    }

    res.json({
      msg: 'success',
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Refund (admin-only) ──────────────────────────────────────── */
router.post('/refund', authAdmin, async (req, res) => {
  try {
    const { payment_id, amount, orderId, reason } = req.body;
    if (!payment_id) return res.status(400).json({ error: 'payment_id required' });

    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const refundOptions = {};
    if (amount) refundOptions.amount = Math.round(amount * 100);

    const refund = await instance.payments.refund(payment_id, refundOptions);

    if (orderId) {
      const order = await Order.findById(orderId);
      if (order) {
        const meta = order.paymentMeta || {};
        const refunds = Array.isArray(meta.refunds) ? meta.refunds : [];
        refunds.push({
          id: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          reason: reason || null,
          createdAt: new Date(),
          raw: refund,
        });

        meta.refunds = refunds;
        meta.refunded = true;
        order.paymentMeta = meta;
        order.paymentStatus = 'Refunded';
        order.cancelledAt = order.cancelledAt || new Date();
        await order.save();
      }
    }

    res.json({ refund });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
