export function mountLegacyFeature(container, feature) {
  container.innerHTML =
    '<div class="legacy-frame-wrap">' +
      '<iframe class="legacy-frame" title="TeamPro ' + escapeHtml(feature) + '" src="app-full.html?lazyTab=' + encodeURIComponent(feature) + '"></iframe>' +
    '</div>';
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
