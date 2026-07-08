const { getClient } = require('../lib/supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('reports')
      .select('id, status, product_name, matched_keyword, reasons, brand, expiration, ingredients, extracted_text, scanned_at, image_base64, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const reports = data.map((row) => ({
      id:             row.id,
      status:         row.status,
      productName:    row.product_name,
      matchedKeyword: row.matched_keyword,
      reasons:        row.reasons,
      brand:          row.brand,
      expiration:     row.expiration,
      ingredients:    row.ingredients,
      extractedText:  row.extracted_text,
      scannedAt:      row.scanned_at,
      imageBase64:    row.image_base64,
    }));

    return res.status(200).json({ ok: true, reports });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
