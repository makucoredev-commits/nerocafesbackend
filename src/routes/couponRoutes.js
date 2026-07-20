import { Router } from 'express';
import { Coupon } from '../models/Coupon.js';
import { authAdmin } from '../middleware/authAdmin.js';

const router = Router();

/**
 * POST /admin/coupons/validate
 * Validate coupon code for checkout/POS
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, customerPhone, orderAmount, customerUserId } = req.body;
    const cleanCode = String(code).toUpperCase().trim();

    const coupon = await Coupon.findOne({ code: cleanCode, isActive: true });
    if (!coupon) {
      return res.json({ valid: false, message: 'Invalid promo code.' });
    }

    // Check time constraints
    const now = new Date();
    if (coupon.startTime && now < coupon.startTime) {
      return res.json({ valid: false, message: 'Coupon not yet active.' });
    }
    if (coupon.endTime && now > coupon.endTime) {
      return res.json({ valid: false, message: 'Coupon has expired.' });
    }

    // Check usage limit
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      return res.json({ valid: false, message: 'Coupon usage limit reached.' });
    }

    // Check customer-specific
    if (coupon.customerIds && coupon.customerIds.length > 0) {
      if (!customerUserId || !coupon.customerIds.includes(customerUserId)) {
        return res.json({ valid: false, message: 'Coupon not applicable for this customer.' });
      }
    }

    // Check minimum order value
    if (coupon.minValue && orderAmount < coupon.minValue) {
      return res.json({ 
        valid: false, 
        message: `Minimum order value ₹${coupon.minValue} required.` 
      });
    }

    // Calculate discount
    let discountAmount = 0;
    let discountPercent = 0;

    if (coupon.type === 'flat') {
      discountAmount = coupon.value;
    } else if (coupon.type === 'percentage') {
      discountPercent = coupon.value;
      discountAmount = (orderAmount * coupon.value) / 100;
      if (coupon.maxValue && discountAmount > coupon.maxValue) {
        discountAmount = coupon.maxValue;
      }
    }

    res.json({
      valid: true,
      couponId: coupon._id,
      discountAmount,
      discountPercent,
      message: `${coupon.name} applied successfully!`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin Coupon Management ─────────────────────────────────────── */

/**
 * GET /admin/coupons
 * Get all coupons
 */
router.get('/', authAdmin, async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ coupons });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/coupons
 * Create coupon
 */
router.post('/', authAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ coupon });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/coupons/:id
 * Update coupon
 */
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
    res.json({ coupon });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /admin/coupons/:id
 * Delete coupon
 */
router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /admin/coupons/:id/increment-usage
 * Increment coupon usage count
 */
router.post('/:id/increment-usage', authAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
      { $inc: { usedCount: 1 } },
      { new: true }
    );
    if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
    res.json({ coupon });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /admin/coupons/analytics
 * Get coupon analytics data
 */
router.get('/analytics', authAdmin, async (req, res) => {
  try {
    const totalCoupons = await Coupon.countDocuments();
    const activeCoupons = await Coupon.countDocuments({ isActive: true });
    const expiredCoupons = await Coupon.countDocuments({ isActive: false });

    // Calculate total redemptions
    const allCoupons = await Coupon.find();
    const totalRedemptions = allCoupons.reduce((sum, coupon) => sum + (coupon.usedCount || 0), 0);

    // Calculate total discount given
    let totalDiscountGiven = 0;
    // This would require order data to calculate actual discounts given
    // For now, estimate based on coupon values
    allCoupons.forEach(coupon => {
      if (coupon.type === 'flat') {
        totalDiscountGiven += (coupon.value || 0) * (coupon.usedCount || 0);
      } else if (coupon.type === 'percentage') {
        // Approximate - would need actual order amounts
        totalDiscountGiven += (coupon.value || 0) * (coupon.usedCount || 0) * 100; // rough estimate
      }
    });

    // Type distribution
    const typeDistribution = await Coupon.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $project: { type: '$_id', count: 1, _id: 0 } }
    ]);

    // Redemption trend (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const redemptionTrend = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      // This would require linking coupons to orders with timestamps
      // For now, return mock data structure
      redemptionTrend.push({ date: dateStr, redemptions: 0 });
    }

    // Top performing coupons
    const topPerformingCoupons = await Coupon.find()
      .sort({ usedCount: -1 })
      .limit(5)
      .select('code name usedCount type value');

    res.json({
      totalCoupons,
      activeCoupons,
      expiredCoupons,
      totalRedemptions,
      totalDiscountGiven,
      typeDistribution: typeDistribution.map(t => ({ name: t.type, count: t.count })),
      redemptionTrend,
      topPerformingCoupons: topPerformingCoupons.map(c => ({
        code: c.code,
        name: c.name,
        redemptions: c.usedCount || 0,
        type: c.type,
        value: c.value
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
