/* ═══════════════════════════════════════════════════════
   Data Engine — CSV Parser + Market Aggregation
   Shared across all tabs. Parses X-Ray CSVs, computes
   KPIs, segments, brands — zero hardcoded values.
   ═══════════════════════════════════════════════════════ */

var DataEngine = (function() {
  'use strict';

  // ── CSV Parser (handles quoted fields with commas) ──
  function parseCSV(text) {
    var lines = text.split('\n');
    if (lines.length < 2) return [];

    // Remove BOM if present
    if (lines[0].charCodeAt(0) === 0xFEFF) {
      lines[0] = lines[0].substring(1);
    }

    var headers = parseCSVLine(lines[0]);
    var rows = [];

    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var values = parseCSVLine(line);
      if (values.length !== headers.length) continue; // skip malformed rows

      var row = {};
      for (var j = 0; j < headers.length; j++) {
        row[headers[j].trim()] = values[j];
      }
      rows.push(row);
    }

    return rows;
  }

  function parseCSVLine(line) {
    var fields = [];
    var current = '';
    var inQuotes = false;

    for (var i = 0; i < line.length; i++) {
      var ch = line[i];

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  }

  // ── Number parsing (handles commas and currency symbols) ──
  function parseNum(val) {
    if (val === undefined || val === null || val === '' || val === '-') return 0;
    var s = String(val).replace(/[$€£,\s]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // ── Detect column names (X-Ray CSVs have slight variations) ──
  function detectColumns(headers) {
    var map = {
      asin: null,
      title: null,
      type: null,
      brand: null,
      price: null,
      sales: null,
      revenue: null,
      bsr: null,
      ratings: null,
      reviewCount: null,
      focus: null
    };

    headers.forEach(function(h) {
      var lc = h.toLowerCase().trim();
      if (lc === 'asin') map.asin = h;
      else if (lc === 'product details' || lc === 'title') map.title = h;
      else if (lc === 'type' || lc === 'segment' || lc === 'focus') map.type = h;
      else if (lc === 'brand') map.brand = h;
      else if (lc.indexOf('price') !== -1) map.price = h;
      else if (lc === 'asin sales' || lc === 'sales') map.sales = h;
      else if (lc === 'asin revenue' || lc === 'revenue') map.revenue = h;
      else if (lc === 'bsr') map.bsr = h;
      else if (lc === 'ratings' || lc === 'rating') map.ratings = h;
      else if (lc === 'review count' || lc === 'reviews') map.reviewCount = h;
      else if (lc === 'focus') map.focus = h;
    });

    return map;
  }

  // ── Load and parse X-Ray CSV from dashboard folder ──
  // xrayDir: optional subfolder name (default: 'x-ray')
  function loadXRay(basePath, filename, xrayDir) {
    var dir = xrayDir || 'x-ray';
    var url = basePath + 'data/' + dir + '/' + filename;
    return fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('Failed to load: ' + url);
        return res.text();
      })
      .then(function(text) {
        var rows = parseCSV(text);
        if (rows.length === 0) throw new Error('Empty CSV: ' + url);

        var headers = Object.keys(rows[0]);
        var cols = detectColumns(headers);

        // Detect local price column (e.g. "Price £" when "Price US$" is also present)
        var localPriceCol = null;
        if (cols.price) {
          var priceLc = cols.price.toLowerCase();
          // If detected price is USD but there's a local currency price, prefer local
          if (priceLc.indexOf('us$') !== -1 || priceLc.indexOf('usd') !== -1) {
            headers.forEach(function(h) {
              var hlc = h.toLowerCase().trim();
              if (hlc.indexOf('price') !== -1 && hlc !== priceLc && (hlc.indexOf('£') !== -1 || hlc.indexOf('€') !== -1)) {
                localPriceCol = h;
              }
            });
          }
        }

        // Normalize rows into standard format
        var products = rows.map(function(row) {
          // Use local price if available, otherwise detected price
          var price = localPriceCol ? parseNum(row[localPriceCol]) : parseNum(row[cols.price]);
          // If local price col exists but is empty/zero, try detected price
          if (localPriceCol && price === 0) price = parseNum(row[cols.price]);

          var sales30d = parseNum(row[cols.sales]);
          var revenue30d = parseNum(row[cols.revenue]);

          // Derive units from revenue/price when ASIN Sales column is missing
          if (sales30d === 0 && revenue30d > 0 && price > 0) {
            sales30d = Math.round(revenue30d / price);
          }

          return {
            asin: row[cols.asin] || '',
            title: row[cols.title] || '',
            type: row[cols.type] || 'Other',
            brand: row[cols.brand] || 'Unknown',
            price: price,
            sales30d: sales30d,
            revenue30d: revenue30d,
            bsr: parseNum(row[cols.bsr]),
            rating: parseNum(row[cols.ratings]),
            reviewCount: parseNum(row[cols.reviewCount]),
            focus: cols.focus ? (row[cols.focus] || '') : ''
          };
        }).filter(function(p) {
          return p.asin && p.asin.length > 0;
        });

        return products;
      });
  }

  // ── Aggregate by segment (Type column) ──
  function aggregateBySegment(products, multiplier) {
    multiplier = multiplier || 12;
    var segMap = {};

    products.forEach(function(p) {
      var seg = p.type || 'Other';
      if (!segMap[seg]) {
        segMap[seg] = { name: seg, asins: 0, units30d: 0, revenue30d: 0, totalPrice: 0, products: [] };
      }
      var s = segMap[seg];
      s.asins++;
      s.units30d += p.sales30d;
      s.revenue30d += p.revenue30d;
      s.totalPrice += p.price;
      s.products.push(p);
    });

    // Convert to array and compute 12M projections
    var segments = Object.keys(segMap).map(function(key) {
      var s = segMap[key];
      return {
        name: s.name,
        asins: s.asins,
        units30d: s.units30d,
        units12m: Math.round(s.units30d * multiplier),
        revenue30d: s.revenue30d,
        revenue12m: Math.round(s.revenue30d * multiplier),
        avgPrice: s.asins > 0 ? Math.round(s.totalPrice / s.asins * 100) / 100 : 0,
        products: s.products
      };
    });

    // Sort by revenue descending
    segments.sort(function(a, b) { return b.revenue12m - a.revenue12m; });

    return segments;
  }

  // ── Aggregate by brand within a segment ──
  // Uses pre-calculated units12m/revenue12m on each product (from calculate12M)
  function aggregateByBrand(products) {
    var brandMap = {};

    products.forEach(function(p) {
      var brand = p.brand || 'Unknown';
      if (!brandMap[brand]) {
        brandMap[brand] = { name: brand, units: 0, rev: 0, asins: 0 };
      }
      var b = brandMap[brand];
      b.asins++;
      b.units += (p.units12m || 0);
      b.rev += (p.revenue12m || 0);
    });

    var brands = Object.keys(brandMap).map(function(key) {
      return brandMap[key];
    });

    // Sort by revenue descending
    brands.sort(function(a, b) { return b.rev - a.rev; });

    // Top N + Other
    return brands;
  }

  // ── Top N brands + "Other" bucket ──
  function topBrandsWithOther(brands, n) {
    n = n || 8;
    if (brands.length <= n + 1) return brands;

    var top = brands.slice(0, n);
    var rest = brands.slice(n);
    var otherUnits = rest.reduce(function(a, b) { return a + b.units; }, 0);
    var otherRev = rest.reduce(function(a, b) { return a + b.rev; }, 0);
    top.push({ name: 'Other', units: otherUnits, rev: otherRev, asins: rest.length });
    return top;
  }

  // ── Load sales CSVs and compute 12M with seasonality ──
  // Returns a map: ASIN → { units12m, monthlyUnits[] }
  function loadSalesData(basePath, products) {
    // Build list of ASINs to fetch
    var asins = products.map(function(p) { return p.asin; }).filter(function(a) { return a; });

    // Fetch all sales CSVs in parallel
    var promises = asins.map(function(asin) {
      var url = basePath + 'data/sales-data/' + asin + '-sales-3y.csv';
      return fetch(url)
        .then(function(res) {
          if (!res.ok) return { asin: asin, data: null };
          return res.text().then(function(text) {
            return { asin: asin, data: parseSalesCSV(text) };
          });
        })
        .catch(function() {
          return { asin: asin, data: null };
        });
    });

    return Promise.all(promises).then(function(results) {
      var salesMap = {};
      results.forEach(function(r) {
        if (r.data) salesMap[r.asin] = r.data;
      });
      return salesMap;
    });
  }

  function parseSalesCSV(text) {
    var lines = text.split('\n');
    if (lines.length < 2) return null;

    // Remove BOM
    if (lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].substring(1);

    var dailySales = [];
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var fields = parseCSVLine(line);
      var dateStr = (fields[0] || '').replace(/"/g, '').trim();
      var units = parseFloat((fields[1] || '0').replace(/"/g, '').replace(/,/g, ''));
      if (isNaN(units)) units = 0;
      if (dateStr && dateStr.length >= 10) {
        dailySales.push({ date: dateStr.substring(0, 10), units: units });
      }
    }
    return dailySales;
  }

  // Calculate seasonality indices from sales data
  // Returns: { indices: [12 floats], months: ['Mar','Apr',...], monthlyTotals: [12 ints] }
  function calculateSeasonality(salesMap, exportMonth) {
    // exportMonth: 0-11 (0=Jan). Determines month ordering.
    // Aggregate all ASIN sales by month
    var monthTotals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // Jan-Dec
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    Object.keys(salesMap).forEach(function(asin) {
      var daily = salesMap[asin];
      if (!daily) return;
      daily.forEach(function(d) {
        var month = parseInt(d.date.substring(5, 7)) - 1; // 0-11
        monthTotals[month] += d.units;
      });
    });

    var avgMonth = monthTotals.reduce(function(a, b) { return a + b; }, 0) / 12;
    if (avgMonth === 0) return null;

    var indices = monthTotals.map(function(t) { return t / avgMonth; });

    // Reorder to start from export month (for display)
    // e.g., if export is March (2), order: Mar, Apr, May, ..., Feb
    var orderedIndices = [];
    var orderedMonths = [];
    var orderedTotals = [];
    for (var i = 0; i < 12; i++) {
      var idx = (exportMonth + i) % 12;
      orderedIndices.push(indices[idx]);
      orderedMonths.push(monthNames[idx]);
      orderedTotals.push(monthTotals[idx]);
    }

    return {
      indices: indices,           // Jan-Dec order (for calculation)
      orderedIndices: orderedIndices, // Starting from export month (for display)
      orderedMonths: orderedMonths,
      orderedTotals: orderedTotals,
      avgMonth: avgMonth
    };
  }

  // Calculate 12M units for each product using seasonality
  // For ASINs WITH sales data: sum actual daily units for last 12 months
  // For ASINs WITHOUT sales data: use seasonality index from those that do
  function calculate12M(products, salesMap, seasonality, exportMonth) {
    if (!seasonality) {
      // No sales data at all — fall back to flat ×12
      products.forEach(function(p) {
        p.units12m = Math.round(p.sales30d * 12);
        p.revenue12m = Math.round(p.units12m * p.price);
        p.hasSalesData = false;
      });
      return products;
    }

    var exportIndex = seasonality.indices[exportMonth];
    var sumAllIndices = seasonality.indices.reduce(function(a, b) { return a + b; }, 0);

    products.forEach(function(p) {
      var salesData = salesMap[p.asin];

      if (salesData && salesData.length > 0) {
        // Has sales data — sum actual units for last 12 months
        // Find the latest date in data to determine the 12M window
        var sorted = salesData.slice().sort(function(a, b) { return b.date.localeCompare(a.date); });
        var latestDate = sorted[0].date;
        var cutoff = subtractMonths(latestDate, 12);

        var total = 0;
        salesData.forEach(function(d) {
          if (d.date >= cutoff) total += d.units;
        });
        p.units12m = Math.round(total);
        p.hasSalesData = true;
      } else {
        // No sales data — use seasonality-adjusted projection
        // baseline = 30d_sales / export_month_index
        // 12M = baseline × sum(all_month_indices)
        if (exportIndex > 0) {
          var baseline = p.sales30d / exportIndex;
          p.units12m = Math.round(baseline * sumAllIndices);
        } else {
          p.units12m = Math.round(p.sales30d * 12);
        }
        p.hasSalesData = false;
      }

      p.revenue12m = Math.round(p.units12m * p.price);
    });

    return products;
  }

  function subtractMonths(dateStr, months) {
    var parts = dateStr.split('-');
    var y = parseInt(parts[0]);
    var m = parseInt(parts[1]) - 1; // 0-based
    var d = parseInt(parts[2]);
    m -= months;
    while (m < 0) { m += 12; y--; }
    var mm = String(m + 1).padStart(2, '0');
    var dd = String(d).padStart(2, '0');
    return y + '-' + mm + '-' + dd;
  }

  // ── Full pipeline: load X-Ray + sales data → compute everything ──
  function loadFullData(basePath, xrayConfig) {
    var xrayFile = xrayConfig.file;
    var exportMonth = xrayConfig.exportMonth; // 0-11 (0=Jan)
    if (exportMonth === undefined) exportMonth = 2; // default March

    return loadXRay(basePath, xrayFile).then(function(products) {
      return loadSalesData(basePath, products).then(function(salesMap) {
        var salesCount = Object.keys(salesMap).length;
        var seasonality = null;

        if (salesCount > 0) {
          seasonality = calculateSeasonality(salesMap, exportMonth);
        }

        // Calculate 12M for each product
        calculate12M(products, salesMap, seasonality, exportMonth);

        return {
          products: products,
          salesMap: salesMap,
          seasonality: seasonality,
          salesFilesFound: salesCount,
          salesFilesMissing: products.length - salesCount,
          exportMonth: exportMonth
        };
      });
    });
  }

  // ── Aggregate segments (using pre-calculated 12M on each product) ──
  function aggregateSegments(products) {
    var segMap = {};

    products.forEach(function(p) {
      var seg = p.type || 'Other';
      if (!segMap[seg]) {
        segMap[seg] = { name: seg, asins: 0, units12m: 0, revenue12m: 0, units30d: 0, revenue30d: 0, totalPrice: 0, products: [] };
      }
      var s = segMap[seg];
      s.asins++;
      s.units12m += p.units12m;
      s.revenue12m += p.revenue12m;
      s.units30d += p.sales30d;
      s.revenue30d += p.revenue30d;
      s.totalPrice += p.price;
      s.products.push(p);
    });

    var segments = Object.keys(segMap).map(function(key) {
      var s = segMap[key];
      return {
        name: s.name,
        asins: s.asins,
        units12m: s.units12m,
        revenue12m: s.revenue12m,
        units30d: s.units30d,
        revenue30d: s.revenue30d,
        avgPrice: s.asins > 0 ? Math.round(s.totalPrice / s.asins * 100) / 100 : 0,
        products: s.products
      };
    });

    segments.sort(function(a, b) { return b.revenue12m - a.revenue12m; });
    return segments;
  }

  // ── Compute totals ──
  function computeTotals(segments) {
    return {
      totalAsins: segments.reduce(function(a, s) { return a + s.asins; }, 0),
      totalUnits12m: segments.reduce(function(a, s) { return a + s.units12m; }, 0),
      totalRevenue12m: segments.reduce(function(a, s) { return a + s.revenue12m; }, 0),
      totalUnits30d: segments.reduce(function(a, s) { return a + s.units30d; }, 0),
      totalRevenue30d: segments.reduce(function(a, s) { return a + s.revenue30d; }, 0)
    };
  }

  // ── Format helpers ──
  function fmtMoney(v, cur) {
    cur = cur || '$';
    if (v >= 1e6) return cur + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return cur + (v / 1e3).toFixed(0) + 'K';
    return cur + Math.round(v);
  }

  function fmtUnits(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return v.toLocaleString();
  }

  function fmtPct(v) {
    return v.toFixed(1) + '%';
  }

  // ── Segment colors (consistent palette) ──
  var SEGMENT_PALETTE = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#ea580c', '#059669', '#e11d48', '#94a3b8'];

  function assignSegmentColors(segments) {
    segments.forEach(function(seg, i) {
      if (!seg.color) {
        seg.color = SEGMENT_PALETTE[i % SEGMENT_PALETTE.length];
      }
    });
    return segments;
  }

  // ── Universal table sorting ──
  // Call once after table is in DOM: DataEngine.makeTableSortable(tableElement)
  // Sorts by data-val attribute (numeric) or text content (string)
  function makeTableSortable(table) {
    if (!table) return;
    var headers = table.querySelectorAll('thead th');
    var tbody = table.querySelector('tbody');
    if (!tbody) return;

    headers.forEach(function(th, colIdx) {
      // Check if this column has numeric data (data-val or numeric text)
      var isNumeric = isColumnNumeric(tbody, colIdx);
      if (!isNumeric) return; // Skip text-only columns

      th.classList.add('sortable');
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      th.addEventListener('click', function() {
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));

        var isAsc = th.classList.contains('asc');
        headers.forEach(function(h) { h.classList.remove('asc', 'desc'); });
        var dir = isAsc ? 'desc' : 'asc';
        th.classList.add(dir);

        rows.sort(function(a, b) {
          var cellA = a.children[colIdx];
          var cellB = b.children[colIdx];
          if (!cellA || !cellB) return 0;

          var valA = cellA.getAttribute('data-val');
          var valB = cellB.getAttribute('data-val');

          if (valA !== null && valB !== null) {
            var nA = parseFloat(valA);
            var nB = parseFloat(valB);
            if (!isNaN(nA) && !isNaN(nB)) {
              return dir === 'asc' ? nA - nB : nB - nA;
            }
          }

          var tA = (cellA.textContent || '').trim();
          var tB = (cellB.textContent || '').trim();
          var numA = parseFloat(tA.replace(/[$\u20ac\u00a3,%,]/g, ''));
          var numB = parseFloat(tB.replace(/[$\u20ac\u00a3,%,]/g, ''));
          if (!isNaN(numA) && !isNaN(numB)) {
            return dir === 'asc' ? numA - numB : numB - numA;
          }

          return dir === 'asc' ? tA.toLowerCase().localeCompare(tB.toLowerCase()) : tB.toLowerCase().localeCompare(tA.toLowerCase());
        });

        rows.forEach(function(row) { tbody.appendChild(row); });
      });
    });
  }

  // Check if a column contains numeric data
  function isColumnNumeric(tbody, colIdx) {
    var rows = tbody.querySelectorAll('tr');
    var numericCount = 0;
    var checked = 0;
    for (var i = 0; i < Math.min(rows.length, 5); i++) {
      var cell = rows[i].children[colIdx];
      if (!cell) continue;
      checked++;
      // Has data-val → numeric
      if (cell.getAttribute('data-val') !== null) { numericCount++; continue; }
      // Text looks like a number (with $, €, %, K, M)
      var text = (cell.textContent || '').trim();
      var cleaned = text.replace(/[$\u20ac\u00a3,%\s]/g, '').replace(/[KMk]$/, '');
      if (cleaned && !isNaN(parseFloat(cleaned))) { numericCount++; }
    }
    return checked > 0 && numericCount >= checked * 0.5;
  }

  // Make all tables in a container sortable
  function makeAllTablesSortable(container) {
    if (!container) return;
    var tables = container.querySelectorAll('table');
    tables.forEach(function(t) { makeTableSortable(t); });
  }

  // ── TopLine: Load multiple marketplace CSVs and aggregate ──
  // marketsConfig: array of { code, file, fxRate, ... } from config.json
  // seasonalityConfig: { method: 'flat'|'custom', multiplier: N }
  // options: { xrayDir: 'x-ray' } — optional overrides
  // Returns same shape that renderTopLine() expects
  function loadToplineData(basePath, marketsConfig, seasonalityConfig, options) {
    var multiplier = (seasonalityConfig && seasonalityConfig.multiplier) || 12;
    var xrayDir = (options && options.xrayDir) || 'x-ray';

    // Load all marketplace CSVs in parallel
    var promises = marketsConfig.map(function(mkt) {
      return loadXRay(basePath, mkt.file, xrayDir).then(function(products) {
        // Apply FX conversion
        var fx = mkt.fxRate || 1;
        if (fx !== 1) {
          products.forEach(function(p) {
            p.price = Math.round(p.price * fx * 100) / 100;
            p.revenue30d = Math.round(p.revenue30d * fx);
          });
        }

        // Compute 12M per product
        products.forEach(function(p) {
          p.units12m = Math.round(p.sales30d * multiplier);
          p.revenue12m = Math.round(p.units12m * p.price);
        });

        // Aggregate totals for this marketplace
        var units30d = 0, units12m = 0, revenue12m = 0;
        products.forEach(function(p) {
          units30d += p.sales30d;
          units12m += p.units12m;
          revenue12m += p.revenue12m;
        });

        return {
          code: mkt.code,
          flag: mkt.flag || '',
          name: mkt.name || mkt.code,
          color: mkt.color || '#94a3b8',
          currency: mkt.currencyLabel || '',
          multiplier: multiplier,
          units30d: Math.round(units30d),
          units12m: Math.round(units12m),
          revenue12m: Math.round(revenue12m),
          products: products
        };
      });
    });

    return Promise.all(promises).then(function(marketResults) {
      // Sort markets by revenue descending
      marketResults.sort(function(a, b) { return b.revenue12m - a.revenue12m; });

      // Aggregate brands across all marketplaces
      var allProducts = [];
      marketResults.forEach(function(m) {
        allProducts = allProducts.concat(m.products);
      });
      var brands = aggregateByBrand(allProducts);
      brands = topBrandsWithOther(brands, 10);

      // Aggregate segments by marketplace (for heatmaps)
      var segments = aggregateSegmentsByMarketplace(marketResults);

      // Compute KPIs
      var totalRev = marketResults.reduce(function(a, m) { return a + m.revenue12m; }, 0);
      var totalUnits = marketResults.reduce(function(a, m) { return a + m.units12m; }, 0);
      var totalAsins = allProducts.length;

      var cur = '€'; // will be overridden by dashboard config
      var kpis = [
        { value: fmtMoney(totalRev, cur), label: 'Total 12M Revenue (all markets)' },
        { value: totalUnits.toLocaleString(), label: 'Total 12M Units Sold' },
        { value: marketResults.length + ' Markets', label: marketResults.map(function(m) { return m.code; }).join(' • ') },
        { value: totalAsins.toLocaleString(), label: 'Total ASINs Tracked' }
      ];

      return {
        markets: marketResults,
        brands: brands,
        segments: segments,
        kpis: kpis,
        totals: { totalRevenue12m: totalRev, totalUnits12m: totalUnits }
      };
    });
  }

  // Build segment data grouped by marketplace (for heatmaps)
  // Returns: { names: [...], colors: [...], data: { segName: { rev: [...], units: [...] } } }
  function aggregateSegmentsByMarketplace(marketResults) {
    // Collect all unique segment names and their totals
    var segTotals = {};
    marketResults.forEach(function(mkt, mktIdx) {
      mkt.products.forEach(function(p) {
        var seg = p.type || 'Other';
        if (!segTotals[seg]) {
          segTotals[seg] = { rev: 0, units: 0 };
        }
        segTotals[seg].rev += p.revenue12m;
        segTotals[seg].units += p.units12m;
      });
    });

    // Sort segment names by total revenue descending
    var segNames = Object.keys(segTotals).sort(function(a, b) {
      return segTotals[b].rev - segTotals[a].rev;
    });

    if (segNames.length <= 1) return null; // No meaningful segments

    // Build per-segment, per-marketplace arrays
    var data = {};
    segNames.forEach(function(seg) {
      data[seg] = {
        rev: new Array(marketResults.length).fill(0),
        units: new Array(marketResults.length).fill(0)
      };
    });

    marketResults.forEach(function(mkt, mktIdx) {
      mkt.products.forEach(function(p) {
        var seg = p.type || 'Other';
        data[seg].rev[mktIdx] += p.revenue12m;
        data[seg].units[mktIdx] += p.units12m;
      });
    });

    // Round values
    segNames.forEach(function(seg) {
      data[seg].rev = data[seg].rev.map(Math.round);
      data[seg].units = data[seg].units.map(Math.round);
    });

    // Assign colors
    var colors = segNames.map(function(_, i) {
      return SEGMENT_PALETTE[i % SEGMENT_PALETTE.length];
    });

    return {
      names: segNames,
      colors: colors,
      data: data
    };
  }

  // ── Public API ──
  return {
    parseCSV: parseCSV,
    parseNum: parseNum,
    detectColumns: detectColumns,
    loadXRay: loadXRay,
    loadSalesData: loadSalesData,
    calculateSeasonality: calculateSeasonality,
    calculate12M: calculate12M,
    loadFullData: loadFullData,
    aggregateSegments: aggregateSegments,
    aggregateBySegment: aggregateBySegment,
    aggregateByBrand: aggregateByBrand,
    topBrandsWithOther: topBrandsWithOther,
    computeTotals: computeTotals,
    assignSegmentColors: assignSegmentColors,
    fmtMoney: fmtMoney,
    fmtUnits: fmtUnits,
    fmtPct: fmtPct,
    makeTableSortable: makeTableSortable,
    makeAllTablesSortable: makeAllTablesSortable,
    loadToplineData: loadToplineData,
    SEGMENT_PALETTE: SEGMENT_PALETTE
  };

})();
