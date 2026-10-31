/* SachetSathi offline geo data.
 *
 * No tiles, no network, no dependency. Two things live here:
 *   1. districts / places — an Odisha gazetteer used to (a) let the user set
 *      their location without a network call and (b) infer an approximate
 *      location for a community report from the words in its caption.
 *   2. outline — a stylised, simplified Odisha boundary for the SVG map.
 *
 * Coordinates are approximate centroids, good to a few km. The app labels
 * anything derived from report text as "≈ from text". The outline is stylised
 * on purpose and is labelled "not for navigation".
 */
'use strict';

(function () {
  // [name, odia name, district, lat, lon, aliases…]
  const PLACES = [
    ['Bhubaneswar', 'ଭୁବନେଶ୍ୱର', 'Khordha', 20.2961, 85.8245, ['bhubaneswar', 'bbsr', 'bhubaneshwar']],
    ['Barang', 'ବାରଙ୍ଗ', 'Khordha', 20.3600, 85.7100, ['barang', 'baranga']],
    ['Cuttack', 'କଟକ', 'Cuttack', 20.4625, 85.8830, ['cuttack', 'kattak']],
    ['Puri', 'ପୁରୀ', 'Puri', 19.8135, 85.8312, ['puri']],
    ['Khordha', 'ଖୋର୍ଦ୍ଧା', 'Khordha', 20.1820, 85.6160, ['khordha', 'khurda']],
    ['Balasore', 'ବାଲେଶ୍ୱର', 'Balasore', 21.4931, 86.9336, ['balasore', 'baleshwar', 'baleswar']],
    ['Bhadrak', 'ଭଦ୍ରକ', 'Bhadrak', 21.0574, 86.5155, ['bhadrak']],
    ['Paradip', 'ପାରାଦ୍ୱୀପ', 'Jagatsinghpur', 20.3165, 86.6110, ['paradip', 'paradweep', 'paradeep']],
    ['Jagatsinghpur', 'ଜଗତସିଂହପୁର', 'Jagatsinghpur', 20.2660, 86.1700, ['jagatsinghpur']],
    ['Kendrapara', 'କେନ୍ଦ୍ରାପଡ଼ା', 'Kendrapara', 20.5015, 86.4226, ['kendrapara']],
    ['Jajpur', 'ଯାଜପୁର', 'Jajpur', 20.8507, 86.3376, ['jajpur']],
    ['Dhenkanal', 'ଢେଙ୍କାନାଳ', 'Dhenkanal', 20.6690, 85.5986, ['dhenkanal']],
    ['Angul', 'ଅନୁଗୋଳ', 'Angul', 20.8400, 85.1018, ['angul']],
    ['Nayagarh', 'ନୟାଗଡ଼', 'Nayagarh', 20.1280, 85.1060, ['nayagarh', 'nayagarh']],
    ['Ganjam', 'ଗଞ୍ଜାମ', 'Ganjam', 19.3800, 84.6000, ['ganjam']],
    ['Berhampur', 'ବ୍ରହ୍ମପୁର', 'Ganjam', 19.3150, 84.7941, ['berhampur', 'brahmapur']],
    ['Gopalpur', 'ଗୋପାଳପୁର', 'Ganjam', 19.2720, 84.9050, ['gopalpur']],
    ['Chatrapur', 'ଛତ୍ରପୁର', 'Ganjam', 19.3600, 84.9900, ['chatrapur']],
    ['Paralakhemundi', 'ପାରଳାଖେମୁଣ୍ଡି', 'Gajapati', 18.7800, 84.0950, ['paralakhemundi', 'parlakhemundi']],
    ['Rayagada', 'ରାୟଗଡ଼ା', 'Rayagada', 19.1700, 83.4150, ['rayagada']],
    ['Koraput', 'କୋରାପୁଟ', 'Koraput', 18.8120, 82.7100, ['koraput']],
    ['Jeypore', 'ଜୟପୁର', 'Koraput', 18.8560, 82.5720, ['jeypore']],
    ['Malkangiri', 'ମାଲକାନଗିରି', 'Malkangiri', 18.3500, 81.8800, ['malkangiri']],
    ['Nabarangpur', 'ନବରଙ୍ଗପୁର', 'Nabarangpur', 19.2300, 82.5480, ['nabarangpur', 'nowrangpur']],
    ['Kalahandi', 'କଳାହାଣ୍ଡି', 'Kalahandi', 19.9100, 83.1650, ['kalahandi']],
    ['Bhawanipatna', 'ଭବାନୀପାଟଣା', 'Kalahandi', 19.9100, 83.1670, ['bhawanipatna']],
    ['Balangir', 'ବଲାଙ୍ଗୀର', 'Balangir', 20.7010, 83.4840, ['balangir', 'bolangir']],
    ['Sambalpur', 'ସମ୍ବଲପୁର', 'Sambalpur', 21.4669, 83.9812, ['sambalpur']],
    ['Bargarh', 'ବରଗଡ଼', 'Bargarh', 21.3340, 83.6190, ['bargarh']],
    ['Rourkela', 'ରାଉରକେଲା', 'Sundargarh', 22.2604, 84.8536, ['rourkela', 'rautkela']],
    ['Sundargarh', 'ସୁନ୍ଦରଗଡ଼', 'Sundargarh', 22.1200, 84.0400, ['sundargarh']],
    ['Jharsuguda', 'ଝାରସୁଗୁଡ଼ା', 'Jharsuguda', 21.8560, 84.0060, ['jharsuguda']],
    ['Debagarh', 'ଦେବଗଡ଼', 'Debagarh', 21.5300, 84.7300, ['debagarh', 'deogarh']],
    ['Keonjhar', 'କେନ୍ଦୁଝର', 'Keonjhar', 21.6300, 85.6000, ['keonjhar', 'kendujhar']],
    ['Baripada', 'ବାରିପଦା', 'Mayurbhanj', 21.9350, 86.7300, ['baripada']],
    ['Mayurbhanj', 'ମୟୂରଭଞ୍ଜ', 'Mayurbhanj', 21.9400, 86.5400, ['mayurbhanj']],
    ['Kandhamal', 'କନ୍ଧମାଳ', 'Kandhamal', 20.4700, 84.2300, ['kandhamal', 'phulbani']],
    ['Boudh', 'ବୌଦ୍ଧ', 'Boudh', 20.8330, 84.3200, ['boudh', 'baudh']],
    ['Subarnapur', 'ସୁବର୍ଣ୍ଣପୁର', 'Subarnapur', 20.8400, 83.9200, ['subarnapur', 'sonepur']],
    ['Nuapada', 'ନୂଆପଡ଼ା', 'Nuapada', 20.8100, 82.5300, ['nuapada']],
    ['Chandipur', 'ଚାନ୍ଦିପୁର', 'Balasore', 21.4600, 86.9100, ['chandipur']],
    ['Konark', 'କୋଣାର୍କ', 'Puri', 19.8876, 86.0945, ['konark']],
    ['Chilika', 'ଚିଲିକା', 'Khordha', 19.7200, 85.3200, ['chilika', 'chilka']],
    ['Talcher', 'ତାଲଚେର', 'Angul', 20.9500, 85.2300, ['talcher']],
    ['Rayagada Town', 'ରାୟଗଡ଼ା ସହର', 'Rayagada', 19.1660, 83.4140, ['rayagada town']]
  ];

  // Districts (superset of places above) for the location picker.
  const DISTRICTS = [
    ['Angul', 'ଅନୁଗୋଳ', 20.84, 85.10],
    ['Balangir', 'ବଲାଙ୍ଗୀର', 20.70, 83.48],
    ['Balasore', 'ବାଲେଶ୍ୱର', 21.49, 86.93],
    ['Bargarh', 'ବରଗଡ଼', 21.33, 83.62],
    ['Bhadrak', 'ଭଦ୍ରକ', 21.06, 86.50],
    ['Boudh', 'ବୌଦ୍ଧ', 20.83, 84.32],
    ['Cuttack', 'କଟକ', 20.46, 85.88],
    ['Debagarh', 'ଦେବଗଡ଼', 21.53, 84.73],
    ['Dhenkanal', 'ଢେଙ୍କାନାଳ', 20.67, 85.60],
    ['Gajapati', 'ଗଜପତି', 18.78, 84.10],
    ['Ganjam', 'ଗଞ୍ଜାମ', 19.38, 84.60],
    ['Jagatsinghpur', 'ଜଗତସିଂହପୁର', 20.27, 86.17],
    ['Jajpur', 'ଯାଜପୁର', 20.85, 86.33],
    ['Jharsuguda', 'ଝାରସୁଗୁଡ଼ା', 21.85, 84.03],
    ['Kalahandi', 'କଳାହାଣ୍ଡି', 19.91, 83.17],
    ['Kandhamal', 'କନ୍ଧମାଳ', 20.47, 84.23],
    ['Kendrapara', 'କେନ୍ଦ୍ରାପଡ଼ା', 20.50, 86.42],
    ['Keonjhar', 'କେନ୍ଦୁଝର', 21.63, 85.60],
    ['Khordha', 'ଖୋର୍ଦ୍ଧା', 20.18, 85.62],
    ['Koraput', 'କୋରାପୁଟ', 18.81, 82.71],
    ['Malkangiri', 'ମାଲକାନଗିରି', 18.35, 81.88],
    ['Mayurbhanj', 'ମୟୂରଭଞ୍ଜ', 21.94, 86.73],
    ['Nabarangpur', 'ନବରଙ୍ଗପୁର', 19.23, 82.55],
    ['Nayagarh', 'ନୟାଗଡ଼', 20.13, 85.10],
    ['Nuapada', 'ନୂଆପଡ଼ା', 20.81, 82.53],
    ['Puri', 'ପୁରୀ', 19.81, 85.83],
    ['Rayagada', 'ରାୟଗଡ଼ା', 19.17, 83.41],
    ['Sambalpur', 'ସମ୍ବଲପୁର', 21.47, 83.98],
    ['Subarnapur', 'ସୁବର୍ଣ୍ଣପୁର', 20.84, 83.92],
    ['Sundargarh', 'ସୁନ୍ଦରଗଡ଼', 22.12, 84.04]
  ];

  const CITIES = [
    ['Bhubaneswar', 'ଭୁବନେଶ୍ୱର', 20.2961, 85.8245],
    ['Cuttack', 'କଟକ', 20.4625, 85.8830],
    ['Puri', 'ପୁରୀ', 19.8135, 85.8312],
    ['Balasore', 'ବାଲେଶ୍ୱର', 21.4931, 86.9336],
    ['Rourkela', 'ରାଉରକେଲା', 22.2604, 84.8536],
    ['Sambalpur', 'ସମ୍ବଲପୁର', 21.4669, 83.9812],
    ['Berhampur', 'ବ୍ରହ୍ମପୁର', 19.3150, 84.7941],
    ['Baripada', 'ବାରିପଦା', 21.9350, 86.7300],
    ['Koraput', 'କୋରାପୁଟ', 18.8120, 82.7100],
    ['Bhawanipatna', 'ଭବାନୀପାଟଣା', 19.9100, 83.1670],
    ['Paradip', 'ପାରାଦ୍ୱୀପ', 20.3165, 86.6110],
    ['Angul', 'ଅନୁଗୋଳ', 20.8400, 85.1018],
    ['Balangir', 'ବଲାଙ୍ଗୀର', 20.7010, 83.4840],
    ['Rayagada', 'ରାୟଗଡ଼ା', 19.1700, 83.4150],
    ['Malkangiri', 'ମାଲକାନଗିରି', 18.3500, 81.8800],
    ['Jharsuguda', 'ଝାରସୁଗୁଡ଼ା', 21.8560, 84.0060]
  ];

  // Stylised Odisha boundary, [lat, lon], clockwise. Simplified on purpose.
  const OUTLINE = [
    [22.55, 84.80], [22.60, 85.40], [22.35, 85.90], [22.10, 86.40], [21.90, 86.75],
    [21.60, 87.00], [21.30, 87.05], [21.00, 86.85], [20.75, 86.95], [20.50, 86.75],
    [20.30, 86.65], [20.05, 86.45], [19.80, 85.95], [19.60, 85.35], [19.30, 85.05],
    [19.10, 84.80], [19.00, 84.55], [18.80, 84.30], [18.70, 83.95], [18.55, 83.55],
    [18.30, 82.95], [18.25, 82.60], [18.10, 82.30], [18.00, 82.10], [18.35, 81.95],
    [18.70, 81.95], [18.85, 82.05], [19.10, 81.85], [19.35, 81.60], [19.60, 81.30],
    [19.85, 81.10], [20.15, 81.35], [20.45, 81.60], [20.75, 82.05], [21.00, 82.35],
    [21.25, 82.60], [21.55, 82.90], [21.85, 83.20], [22.05, 83.60], [22.30, 84.00],
    [22.45, 84.40], [22.55, 84.80]
  ];

  // Bay of Bengal marker for map orientation.
  const SEA_LABEL = { name: 'Bay of Bengal', odia: 'ବଙ୍ଗୋପସାଗର', lat: 19.4, lon: 87.6 };

  window.SACHET_GEO = {
    places: PLACES,
    districts: DISTRICTS,
    cities: CITIES,
    outline: OUTLINE,
    seaLabel: SEA_LABEL,
    defaultPlace: PLACES[0], // Bhubaneswar
    /** Great-circle distance in km between two lat/lon pairs. */
    distanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    },
    /**
     * Find the best gazetteer match for free text (a report caption).
     * Returns {place, matched} or null. Longest alias wins to avoid
     * "pur" matching inside other words.
     */
    matchPlace(text) {
      if (!text) return null;
      const hay = String(text).toLowerCase();
      let best = null;
      for (const row of PLACES) {
        const [name, odia, district, lat, lon, aliases] = row;
        const candidates = [name.toLowerCase(), odia, district.toLowerCase(), ...(aliases || [])];
        for (const cand of candidates) {
          if (!cand) continue;
          const needle = cand.toLowerCase();
          if (needle.length < 3) continue;
          // word-boundary-ish match for latin; substring for Odia script
          const isLatin = /[a-z]/.test(needle);
          const hit = isLatin
            ? new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(hay)
            : hay.includes(needle);
          if (hit && (!best || needle.length > best.len)) {
            best = { len: needle.length, place: { name, odia, district, lat, lon } };
          }
        }
      }
      return best ? best.place : null;
    },
    /** Nearest known place to a coordinate (for naming a GPS fix). */
    nearestPlace(lat, lon) {
      let best = null;
      for (const row of PLACES) {
        const [name, odia, district, plat, plon] = row;
        const d = window.SACHET_GEO.distanceKm(lat, lon, plat, plon);
        if (!best || d < best.d) best = { d, place: { name, odia, district, lat: plat, lon: plon } };
      }
      return best;
    },
    search(term) {
      const q = String(term || '').trim().toLowerCase();
      if (!q) return [];
      const seen = new Set();
      const out = [];
      const push = (name, odia, district, lat, lon, kind) => {
        const key = `${name}|${district}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name, odia, district, lat, lon, kind });
      };
      for (const [name, odia, lat, lon] of DISTRICTS) {
        if (name.toLowerCase().includes(q) || odia.includes(term)) {
          push(name, odia, name, lat, lon, 'district');
        }
      }
      for (const row of PLACES) {
        const [name, odia, district, lat, lon, aliases] = row;
        const hay = `${name} ${district} ${(aliases || []).join(' ')}`.toLowerCase();
        if (hay.includes(q) || odia.includes(term)) {
          push(name, odia, district, lat, lon, 'place');
        }
      }
      return out.slice(0, 24);
    }
  };
})();
