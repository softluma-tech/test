export const escapeHtml = (str) =>
  String(str).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export const validateTraderId = (id) => {
  return /^\d{8}$/.test(id);
};

export const generateAffiliateLink = (lid) => {
  const params = new URLSearchParams({
    lid: String(lid),
  });
  return `https://broker-qx.pro/sign-up/?${params.toString()}`;
};
