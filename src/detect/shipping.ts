const SHIP_CUE =
  /\b(track(?:ing)?|shipped|shipment|out for delivery|on its way|delivered|delivery|package|parcel|courier|carrier|usps|ups|fedex|dhl)\b/i;
const TRACKING = [
  /\b(1Z[0-9A-Z]{16})\b/,
  /tracking\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Za-z0-9]{10,35})\b/i,
];

export function detectShipping(text: string): {
  tracking_numbers: string[];
  would_notify: boolean;
} {
  if (!SHIP_CUE.test(text)) return { tracking_numbers: [], would_notify: false };
  const nums: string[] = [];
  for (const re of TRACKING) {
    const m = text.match(re);
    if (m?.[1]) nums.push(m[1]);
  }
  const tracking_numbers = [...new Set(nums)];
  return {
    tracking_numbers,
    would_notify: tracking_numbers.length > 0,
  };
}
