/* ═══════════════════════════════════════════════════════
   Dashboard Hub — Router, Sidebar, Dashboard Loader
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  var config = null;
  var currentId = null;
  var isAdmin = new URLSearchParams(window.location.search).get('admin') === 'true';

  // ── Init ──
  fetchConfig();

  function fetchConfig() {
    // Prefer inlined config (window.HUB_CONFIG from config.js) — działa na file:// bez fetch.
    if (window.HUB_CONFIG) {
      config = window.HUB_CONFIG;
      renderSidebar();
      handleRoute();
      if (isAdmin) {
        document.getElementById('sidebarFooter').style.display = 'block';
      }
      return;
    }
    // Fallback: fetch config.json (działa po HTTP / GitHub Pages, nie na file://).
    fetch('config.json')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        config = data;
        renderSidebar();
        handleRoute();
        if (isAdmin) {
          document.getElementById('sidebarFooter').style.display = 'block';
        }
      })
      .catch(function(err) {
        console.error('Failed to load config.json:', err);
        document.getElementById('emptyState').querySelector('p').textContent =
          'Nie udało się wczytać konfiguracji. Otwórz przez lokalny serwer (python -m http.server) lub użyj config.js.';
      });
  }

  // ── Sidebar ──
  function renderSidebar() {
    var nav = document.getElementById('sidebarNav');
    var topline = config.dashboards.filter(function(d) { return d.group === 'topline'; });
    var detailed = config.dashboards.filter(function(d) { return d.group === 'detailed'; });
    var html = '';

    if (topline.length > 0) {
      html += '<div class="sidebar-group">';
      html += '<div class="sidebar-group-title">Przeglądowe <span style="opacity:.5;font-weight:400">(Top Line)</span></div>';
      topline.forEach(function(d) {
        html += sidebarButton(d);
      });
      html += '</div>';
    }

    if (detailed.length > 0) {
      html += '<div class="sidebar-group">';
      html += '<div class="sidebar-group-title">Szczegółowe <span style="opacity:.5;font-weight:400">(Detailed)</span></div>';
      detailed.forEach(function(d) {
        html += sidebarButton(d);
      });
      html += '</div>';
    }

    nav.innerHTML = html;

    // Attach click handlers
    nav.querySelectorAll('.sidebar-item').forEach(function(btn) {
      btn.addEventListener('click', function() {
        window.location.hash = btn.dataset.id;
      });
    });
  }

  function sidebarButton(d) {
    var dotColor = d.group === 'topline' ? '#2563eb' : '#16a34a';
    return '<button class="sidebar-item" data-id="' + d.id + '">' +
      '<span class="sidebar-item-dot" style="background:' + dotColor + '"></span>' +
      '<span class="sidebar-item-label">' + d.title + '</span>' +
      '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</button>';
  }

  function updateActiveState(id) {
    document.querySelectorAll('.sidebar-item').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.id === id);
    });
  }

  // ── Router ──
  window.addEventListener('hashchange', handleRoute);

  function handleRoute() {
    var hash = window.location.hash.replace('#', '');
    if (!hash && config.dashboards.length > 0) {
      // Default to first dashboard
      window.location.hash = config.dashboards[0].id;
      return;
    }
    if (hash && hash !== currentId) {
      loadDashboard(hash);
    }
  }

  // ── Dashboard Loader ──
  function loadDashboard(id) {
    var entry = config.dashboards.find(function(d) { return d.id === id; });
    if (!entry) {
      showError('Dashboard "' + id + '" nie znaleziono w konfiguracji');
      return;
    }

    // ── PLACEHOLDER GUARD ──
    // Pozycje z _status === "do_zbudowania" pokazują ekran zastępczy zamiast ładować dashboard.
    // Po zbudowaniu realnego dashboardu usuń pole "_status" z config.json dla danego id.
    if (entry._status === 'do_zbudowania') {
      currentId = id;
      updateActiveState(id);
      var ph = document.getElementById('dashboardContainer');
      ph.innerHTML = '<div style="max-width:720px;margin:80px auto;padding:48px;text-align:center;background:#fff;border-radius:12px;border:1px solid #e2e8f0">' +
        '<div style="font-size:3.5rem;margin-bottom:16px">📊</div>' +
        '<h2 style="font-size:1.5rem;color:#0f172a;margin-bottom:12px">' + entry.title + '</h2>' +
        '<p style="color:#64748b;line-height:1.6">Ten dashboard nie jest jeszcze zbudowany. To slot rezerwacyjny w strukturze konsoli.</p>' +
        '<p style="color:#94a3b8;font-size:.82rem;margin-top:20px">Plik docelowy: <code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">dashboards/' + entry.id + '/' + (entry.file || 'index.html') + '</code></p>' +
        '<p style="color:#94a3b8;font-size:.82rem;margin-top:8px">Grupa: <b>' + (entry.group === 'topline' ? 'Przeglądowe' : 'Szczegółowe') + '</b></p>' +
        '</div>';
      document.getElementById('emptyState').style.display = 'none';
      ph.style.display = 'block';
      document.getElementById('loading').style.display = 'none';
      return;
    }
    // ── END PLACEHOLDER GUARD ──

    currentId = id;
    updateActiveState(id);
    showLoading(true);

    var basePath = 'dashboards/' + id + '/';

    // ── Standalone fast path ──
    // Standalone dashboards are self-contained HTML files. Skip the entire
    // fetch/parse/render pipeline and let renderDashboard inject an iframe.
    if (entry.template === 'standalone') {
      renderDashboard({}, '', entry);
      showLoading(false);
      return;
    }

    // Fetch per-dashboard config + template in parallel
    // dashboard.json is optional for topline CSV-driven dashboards
    Promise.all([
      fetch(basePath + 'dashboard.json').then(function(res) {
        if (!res.ok) return null;
        return res.json();
      }).catch(function() { return null; }),
      fetch(basePath + 'config.json').then(function(res) {
        if (!res.ok) return null;
        return res.json();
      }).catch(function() { return null; }),
      loadTemplate(entry.template)
    ])
      .then(function(results) {
        var data = results[0] || {};
        var dashConfig = results[1];
        var templateHtml = results[2];

        // Merge per-dashboard config tabs into entry
        if (dashConfig && dashConfig.tabs) {
          entry.tabs = dashConfig.tabs.map(function(tab) {
            return {
              id: tab.id,
              type: tab.source || 'base',
              label: tab.position + ' \u2014 ' + formatTabLabel(tab.id),
              template: tab.template || tab.id
            };
          });
        }

        // ── TopLine CSV-driven pipeline ──
        // If config.json has markets[] with file references → compute from CSVs
        if (dashConfig && dashConfig.markets && dashConfig.markets[0] && dashConfig.markets[0].file) {
          var cur = dashConfig.currency || '€';
          var tlOptions = { xrayDir: dashConfig.xrayDir || 'x-ray' };
          return DataEngine.loadToplineData(basePath, dashConfig.markets, dashConfig.seasonality, tlOptions).then(function(computed) {
            // Update KPI currency formatting
            computed.kpis[0].value = DataEngine.fmtMoney(computed.totals.totalRevenue12m, cur);

            var tlData = {
              title: dashConfig.title || entry.title,
              subtitle: dashConfig.subtitle || '12-Month Projection',
              currency: cur,
              seasonality: dashConfig.seasonality,
              markets: computed.markets,
              brands: computed.brands,
              segments: computed.segments,
              kpis: computed.kpis,
              note: dashConfig.note || ''
            };
            return { data: tlData, template: templateHtml };
          });
        }

        // ── Detailed CSV-driven pipeline ──
        if (data.xray && data.xray.file) {
          return DataEngine.loadFullData(basePath, data.xray).then(function(result) {
            var segments = DataEngine.aggregateSegments(result.products);
            segments = DataEngine.assignSegmentColors(segments);
            var totals = DataEngine.computeTotals(segments);

            var brandsBySegment = {};
            segments.forEach(function(seg) {
              var brands = DataEngine.aggregateByBrand(seg.products);
              brandsBySegment[seg.name] = DataEngine.topBrandsWithOther(brands, 8);
            });

            data._computed = {
              products: result.products,
              segments: segments,
              totals: totals,
              brandsBySegment: brandsBySegment,
              seasonality: result.seasonality,
              salesFilesFound: result.salesFilesFound,
              salesFilesMissing: result.salesFilesMissing,
              exportMonth: result.exportMonth,
              currency: data.currency || '$'
            };

            return { data: data, template: templateHtml };
          });
        }

        // ── Fallback: hardcoded dashboard.json (legacy topline) ──
        return { data: data, template: templateHtml };
      })
      .then(function(result) {
        renderDashboard(result.data, result.template, entry);
        showLoading(false);
      })
      .catch(function(err) {
        console.error('Failed to load dashboard:', err);
        showError('Failed to load "' + entry.title + '". Check that dashboards/' + id + '/ files exist. Error: ' + err.message);
        showLoading(false);
      });
  }

  function formatTabLabel(id) {
    var labels = {
      'total-market': 'Total Market',
      'market-structure': 'Market Structure',
      'reviews': 'Reviews',
      'keyword-analysis': 'KW Analysis',
      'marketing-deep-dive': 'Marketing Deep-Dive',
      'voc': 'Reviews VOC',
      'listing-communication': 'Listing Comm',
      'copy-brief': 'Copy Brief',
      'image-strategy': 'Image Strategy'
    };
    return labels[id] || id.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  // Template cache
  var templateCache = {};

  function loadTemplate(type) {
    if (templateCache[type]) {
      return Promise.resolve(templateCache[type]);
    }
    return fetch('templates/' + type + '/template.html')
      .then(function(res) {
        if (!res.ok) throw new Error('Template not found: ' + type);
        return res.text();
      })
      .then(function(html) {
        templateCache[type] = html;
        return html;
      });
  }

  function renderDashboard(data, templateHtml, entry) {
    var container = document.getElementById('dashboardContainer');
    var emptyState = document.getElementById('emptyState');

    // Clean up previous dashboard
    Object.values(Chart.instances).forEach(function(c) { c.destroy(); });
    window._DASH_DATA = null;

    emptyState.style.display = 'none';
    container.style.display = 'block';

    // ── Standalone iframe dashboard ──
    // For dashboards rendered as a self-contained HTML file, load it in an iframe
    // and skip the templates/data pipeline entirely.
    if (entry.template === 'standalone') {
      var src = 'dashboards/' + entry.id + '/' + (entry.file || 'index.html');
      container.innerHTML = '<iframe src="' + src + '" style="width:100%;height:calc(100vh - 0px);border:0;display:block"></iframe>';
      document.getElementById('sidebar').classList.remove('open');
      return;
    }

    container.innerHTML = templateHtml;

    // Inject data and run rendering engine
    if (entry.template === 'topline') {
      renderTopLine(data, container);
    } else if (entry.template === 'detailed') {
      renderDetailed(data, container, entry);
    }

    // Close sidebar on mobile after selection
    document.getElementById('sidebar').classList.remove('open');
  }

  // ── TopLine Rendering Engine ──
  function renderTopLine(D, container) {
    Chart.register(ChartDataLabels);

    var markets = D.markets;
    var LABELS = markets.map(function(m) { return m.code; });
    var REVENUE = markets.map(function(m) { return m.revenue12m; });
    var UNITS = markets.map(function(m) { return m.units12m; });
    var COLORS = markets.map(function(m) { return m.color; });
    var totalRev = REVENUE.reduce(function(a, b) { return a + b; }, 0);
    var totalUnits = UNITS.reduce(function(a, b) { return a + b; }, 0);
    var totalUnits30d = markets.reduce(function(a, m) { return a + m.units30d; }, 0);
    var cur = D.currency || '\u20ac';

    // Header
    container.querySelector('.dashboard-header h2').textContent = D.title;
    container.querySelector('.dashboard-header span').textContent = D.subtitle;

    // KPIs
    container.querySelector('.kpi-row').innerHTML = D.kpis.map(function(k) {
      return '<div class="kpi"><div class="kpi-v">' + k.value + '</div><div class="kpi-l">' + k.label + '</div></div>';
    }).join('');

    // Chart titles
    container.querySelector('#tlBarTitle').textContent = D.barTitle || 'Revenue by Marketplace \u2014 12M (' + cur + ')';
    container.querySelector('#tlPieTitle').textContent = D.pieTitle || 'Unit Share by Marketplace \u2014 12M';
    container.querySelector('#tlTableTitle').textContent = D.tableTitle || 'Units & Revenue by Marketplace \u2014 12M';

    // Multiplier column header — shows the multiplier used (e.g. ×12, ×21, or "Seasonal")
    var multiplierHeader = container.querySelector('#tlMultiplierHeader');
    if (multiplierHeader) {
      if (D.seasonality && D.seasonality.method === 'historical') {
        multiplierHeader.textContent = 'Seasonal';
      } else {
        var mult = (D.seasonality && D.seasonality.multiplier) || 12;
        multiplierHeader.textContent = '\u00d7' + mult;
      }
    }

    function fmtCur(v) {
      return v >= 1e6 ? cur + (v / 1e6).toFixed(1) + 'M' : cur + (v / 1e3).toFixed(0) + 'K';
    }

    // Bar chart
    new Chart(container.querySelector('#tlBarChart'), {
      type: 'bar',
      data: {
        labels: LABELS,
        datasets: [{
          data: REVENUE,
          backgroundColor: COLORS,
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: { size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12,
              generateLabels: function() {
                return LABELS.map(function(label, i) {
                  return {
                    text: label + '  ' + (REVENUE[i] / totalRev * 100).toFixed(1) + '%',
                    fillStyle: COLORS[i], strokeStyle: COLORS[i], lineWidth: 0, index: i, hidden: false
                  };
                });
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) { return ' ' + cur + ctx.parsed.y.toLocaleString('en', { maximumFractionDigits: 0 }); }
            }
          },
          datalabels: {
            anchor: 'end', align: 'end',
            formatter: function(v) { return fmtCur(v); },
            font: { size: 11, weight: '600' }, color: '#1e293b'
          }
        },
        layout: { padding: { top: 22 } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 } } },
          y: { grid: { color: '#e2e8f0' }, ticks: { callback: function(v) { return fmtCur(v); } } }
        }
      }
    });

    // Doughnut chart
    new Chart(container.querySelector('#tlPieChart'), {
      type: 'doughnut',
      data: {
        labels: LABELS,
        datasets: [{ data: UNITS, backgroundColor: COLORS, borderWidth: 2, borderColor: '#fff' }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '52%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: { size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12,
              generateLabels: function(chart) {
                return chart.data.labels.map(function(label, i) {
                  var pct = (chart.data.datasets[0].data[i] / totalUnits * 100).toFixed(1);
                  return { text: label + '  ' + pct + '%', fillStyle: COLORS[i], strokeStyle: COLORS[i], lineWidth: 0, index: i, hidden: false };
                });
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var pct = (ctx.parsed / totalUnits * 100).toFixed(1);
                return ' ' + ctx.parsed.toLocaleString() + ' units (' + pct + '%)';
              }
            }
          },
          datalabels: {
            display: function(ctx) { return ctx.dataIndex < 3; },
            formatter: function(v) { return (v / totalUnits * 100).toFixed(1) + '%'; },
            color: '#fff', font: { size: 11, weight: '700' }
          }
        }
      }
    });

    // Market table
    var sortState = { key: null, dir: 'desc' };

    // Determine multiplier display per row
    var isHistorical = D.seasonality && D.seasonality.method === 'historical';
    var defaultMult = (D.seasonality && D.seasonality.multiplier) || 12;

    function getMultiplierLabel(m) {
      if (isHistorical) {
        // If historical, compute effective multiplier from data
        if (m.units30d > 0) return (m.units12m / m.units30d).toFixed(1) + '\u00d7';
        return '\u2014';
      }
      var mult = m.multiplier || defaultMult;
      return mult + '\u00d7';
    }

    function renderMarketTable(data) {
      var rows = data.map(function(m) {
        var share = (m.revenue12m / totalRev * 100).toFixed(1);
        return '<tr>' +
          '<td><span class="dot" style="background:' + m.color + '"></span>' + (m.flag || '') + ' ' + m.name + '</td>' +
          '<td>' + m.currency + '</td>' +
          '<td class="num">' + m.units30d.toLocaleString() + '</td>' +
          '<td class="num">' + getMultiplierLabel(m) + '</td>' +
          '<td class="num">' + m.units12m.toLocaleString() + '</td>' +
          '<td class="num">' + cur + m.revenue12m.toLocaleString() + '</td>' +
          '<td class="num">' + share + '%</td></tr>';
      }).join('');
      rows += '<tr class="total-row"><td colspan="2"><strong>Total</strong></td>' +
        '<td class="num">' + totalUnits30d.toLocaleString() + '</td>' +
        '<td class="num">\u2014</td>' +
        '<td class="num">' + totalUnits.toLocaleString() + '</td>' +
        '<td class="num">' + cur + totalRev.toLocaleString() + '</td>' +
        '<td class="num">100%</td></tr>';
      container.querySelector('#tlTableBody').innerHTML = rows;
    }

    renderMarketTable(markets);

    container.querySelectorAll('th.sortable').forEach(function(th) {
      th.addEventListener('click', function() {
        var key = th.dataset.sort;
        if (sortState.key === key) { sortState.dir = sortState.dir === 'desc' ? 'asc' : 'desc'; }
        else { sortState.key = key; sortState.dir = 'desc'; }
        container.querySelectorAll('th.sortable').forEach(function(h) { h.classList.remove('asc', 'desc'); });
        th.classList.add(sortState.dir);
        var sorted = markets.slice().sort(function(a, b) {
          var va = key === 'share' ? a.revenue12m / totalRev : a[key];
          var vb = key === 'share' ? b.revenue12m / totalRev : b[key];
          return sortState.dir === 'asc' ? va - vb : vb - va;
        });
        renderMarketTable(sorted);
      });
    });

    // Brand Share Pies (if brand data exists)
    if (D.brands && D.brands.length > 0) {
      var PALETTE = ['#2563eb','#dc2626','#0891b2','#d97706','#7c3aed','#ea580c','#059669','#e11d48','#8b5cf6','#0284c7','#94a3b8'];

      function sortedBrandPie(canvasId, sortKey, total, prefix) {
        var canvas = container.querySelector('#' + canvasId);
        if (!canvas) return;

        var other = D.brands.filter(function(b) { return b.name === 'Other'; });
        var rest = D.brands.filter(function(b) { return b.name !== 'Other'; });
        rest.sort(function(a, b) { return b[sortKey] - a[sortKey]; });
        var sorted = rest.concat(other);
        var labels = sorted.map(function(b) { return b.name; });
        var values = sorted.map(function(b) { return b[sortKey]; });
        var colors = sorted.map(function(_, i) { return PALETTE[i % PALETTE.length]; });

        new Chart(canvas, {
          type: 'doughnut',
          data: {
            labels: labels,
            datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '48%',
            plugins: {
              legend: {
                position: 'right',
                labels: {
                  font: { size: 10.5 }, padding: 7, boxWidth: 11, boxHeight: 11,
                  generateLabels: function(chart) {
                    return chart.data.labels.map(function(label, i) {
                      var p = (chart.data.datasets[0].data[i] / total * 100).toFixed(1);
                      return { text: label + '  ' + p + '%', fillStyle: colors[i], strokeStyle: colors[i], lineWidth: 0, index: i, hidden: false };
                    });
                  }
                }
              },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    var p = (ctx.parsed / total * 100).toFixed(1);
                    return prefix === cur
                      ? ' ' + cur + ctx.parsed.toLocaleString() + ' (' + p + '%)'
                      : ' ' + ctx.parsed.toLocaleString() + ' units (' + p + '%)';
                  }
                }
              },
              datalabels: {
                display: function(ctx) { return (ctx.dataset.data[ctx.dataIndex] / total * 100) >= 5; },
                formatter: function(v) { return (v / total * 100).toFixed(1) + '%'; },
                color: '#fff', font: { size: 10.5, weight: '700' }
              }
            }
          }
        });
      }

      var brandTotalRev = D.brands.reduce(function(a, b) { return a + b.rev; }, 0);
      var brandTotalUnits = D.brands.reduce(function(a, b) { return a + b.units; }, 0);
      sortedBrandPie('tlBrandRevPie', 'rev', brandTotalRev, cur);
      sortedBrandPie('tlBrandUnitsPie', 'units', brandTotalUnits, '#');
    } else {
      // Hide brand section if no brand data
      var brandSection = container.querySelector('#tlBrandSection');
      if (brandSection) brandSection.style.display = 'none';
    }

    // Heatmaps (if segment data exists)
    if (D.segments) {
      renderHeatmaps(D, container, cur);
    } else {
      var hmSection = container.querySelector('#tlHeatmapSection');
      if (hmSection) hmSection.style.display = 'none';
    }

    // Note
    var noteEl = container.querySelector('#tlNote');
    if (noteEl && D.note) {
      noteEl.innerHTML = D.note;
    }
  }

  function renderHeatmaps(D, container, cur) {
    var segData = D.segments.data;
    var segNames = D.segments.names;
    var marketCodes = D.markets.map(function(m) { return m.code; });
    var HM_COLORS = ['#eff6ff','#bfdbfe','#93c5fd','#3b82f6','#1d4ed8'];
    var HM_TEXT = ['#1e40af','#1e40af','#1e3a5f','#ffffff','#ffffff'];

    function hmColor(val, max) {
      if (val === 0) return { bg: '#f8fafc', fg: '#94a3b8' };
      var idx = Math.min(4, Math.floor((val / max) * 4.99));
      return { bg: HM_COLORS[idx], fg: HM_TEXT[idx] };
    }

    function fmtRev(v) {
      if (v === 0) return '\u2014';
      return v >= 1e6 ? cur + (v / 1e6).toFixed(1) + 'M' : cur + (v / 1e3).toFixed(0) + 'K';
    }

    function fmtUnits(v) {
      if (v === 0) return '\u2014';
      return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(1) + 'K';
    }

    // Update heatmap table headers
    ['tlRevHeatmap', 'tlUnitsHeatmap'].forEach(function(tableId) {
      var thead = container.querySelector('#' + tableId + ' thead tr');
      if (thead) {
        var ths = '<th>Segment</th>';
        marketCodes.forEach(function(code) { ths += '<th class="num">' + code + '</th>'; });
        ths += '<th class="num" style="border-left:2px solid #e2e8f0">Total</th>';
        thead.innerHTML = ths;
      }
    });

    function buildHeatmap(tableId, field, fmtFn) {
      var tbody = container.querySelector('#' + tableId + ' tbody');
      if (!tbody) return;
      var allVals = [];
      segNames.forEach(function(s) {
        segData[s][field].forEach(function(v) { if (v > 0) allVals.push(v); });
      });
      var maxVal = Math.max.apply(null, allVals);

      segNames.forEach(function(seg) {
        var vals = segData[seg][field];
        var total = vals.reduce(function(a, b) { return a + b; }, 0);
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="seg-label">' + seg + '</td>';
        vals.forEach(function(v) {
          var c = hmColor(v, maxVal);
          tr.innerHTML += '<td class="hm" style="background:' + c.bg + ';color:' + c.fg + '">' + fmtFn(v) + '</td>';
        });
        tr.innerHTML += '<td class="hm-total">' + fmtFn(total) + '</td>';
        tbody.appendChild(tr);
      });

      // Total row
      var numMarkets = marketCodes.length;
      var totals = [];
      for (var i = 0; i < numMarkets; i++) {
        var colTotal = segNames.reduce(function(s, seg) { return s + segData[seg][field][i]; }, 0);
        totals.push(colTotal);
      }
      var grandTotal = totals.reduce(function(a, b) { return a + b; }, 0);
      var tr = document.createElement('tr');
      tr.className = 'total-row';
      tr.innerHTML = '<td class="seg-label">Total</td>';
      totals.forEach(function(v) { tr.innerHTML += '<td class="hm" style="background:#f8fafc;color:#0f2942">' + fmtFn(v) + '</td>'; });
      tr.innerHTML += '<td class="hm-total">' + fmtFn(grandTotal) + '</td>';
      tbody.appendChild(tr);
    }

    // Segment pie charts
    if (D.segments.colors) {
      var segRevTotals = segNames.map(function(s) { return segData[s].rev.reduce(function(a, b) { return a + b; }, 0); });
      var segUnitTotals = segNames.map(function(s) { return segData[s].units.reduce(function(a, b) { return a + b; }, 0); });

      function segPie(canvasId, data, fmtVal) {
        var canvas = container.querySelector('#' + canvasId);
        if (!canvas) return;
        var total = data.reduce(function(a, b) { return a + b; }, 0);
        new Chart(canvas, {
          type: 'doughnut',
          data: {
            labels: segNames,
            datasets: [{ data: data, backgroundColor: D.segments.colors, borderWidth: 2, borderColor: '#fff' }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '52%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  font: { size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12,
                  generateLabels: function() {
                    return segNames.map(function(label, i) {
                      var pct = (data[i] / total * 100).toFixed(1);
                      return { text: label + '  ' + pct + '%', fillStyle: D.segments.colors[i], strokeStyle: D.segments.colors[i], lineWidth: 0, index: i, hidden: false };
                    });
                  }
                }
              },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    var pct = (ctx.parsed / total * 100).toFixed(1);
                    return ' ' + fmtVal(ctx.parsed) + ' (' + pct + '%)';
                  }
                }
              },
              datalabels: {
                display: function(ctx) { return (ctx.dataset.data[ctx.dataIndex] / total) > 0.05; },
                formatter: function(v) { return (v / total * 100).toFixed(1) + '%'; },
                color: '#fff', font: { size: 11, weight: '700' }
              }
            }
          }
        });
      }

      segPie('tlSegRevPie', segRevTotals, function(v) { return fmtRev(v); });
      segPie('tlSegUnitsPie', segUnitTotals, function(v) { return fmtUnits(v); });
    }

    buildHeatmap('tlRevHeatmap', 'rev', fmtRev);
    buildHeatmap('tlUnitsHeatmap', 'units', fmtUnits);
  }

  // ── Detailed Rendering Engine (stub — Phase 2) ──
  // Tab template cache
  var tabTemplateCache = {};

  function loadTabTemplate(tabId) {
    // Map base tab IDs to their template folder names
    var templateName = tabId;
    if (tabTemplateCache[templateName]) {
      return Promise.resolve(tabTemplateCache[templateName]);
    }
    return fetch('templates/tabs/' + templateName + '/template.html')
      .then(function(res) {
        if (!res.ok) throw new Error('Tab template not found: ' + templateName);
        return res.text();
      })
      .then(function(html) {
        tabTemplateCache[templateName] = html;
        return html;
      });
  }

  function renderDetailed(data, container, entry) {
    // Header — use sidebar title for consistency, fallback to dashboard.json
    container.querySelector('.dashboard-header h2').textContent = entry.title || data.title;
    container.querySelector('.dashboard-header span').textContent = data.subtitle || '';

    var tabs = entry.tabs || [
      { id: 'total-market', type: 'base', label: '1 \u2014 Total Market' },
      { id: 'market-structure', type: 'base', label: '2 \u2014 Market Structure' },
      { id: 'reviews', type: 'base', label: '3 \u2014 Reviews' }
    ];

    // Build tab bar
    var tabBar = container.querySelector('#dtTabBar');
    tabBar.innerHTML = tabs.map(function(tab, i) {
      var activeClass = i === 0 ? ' active' : '';
      return '<button class="tab' + activeClass + '" data-panel="dt-' + tab.id + '" data-tab-idx="' + i + '">' + tab.label + '</button>';
    }).join('');

    // Build panel containers (empty initially)
    var panelsContainer = container.querySelector('#dtPanels');
    panelsContainer.innerHTML = tabs.map(function(tab, i) {
      var activeClass = i === 0 ? ' active' : '';
      return '<div class="panel' + activeClass + '" id="dt-' + tab.id + '">' +
        '<div class="loading" style="height:200px"><div class="spinner"></div><p>Loading tab...</p></div>' +
        '</div>';
    }).join('');

    // Track which tabs have been loaded
    var loadedTabs = {};

    // Load and render the first tab immediately
    loadTabContent(tabs[0], data);

    // Wire tab switching
    tabBar.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.dataset.tabIdx);
        var tab = tabs[idx];

        // Switch active states
        tabBar.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        panelsContainer.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var panel = document.getElementById('dt-' + tab.id);
        if (panel) panel.classList.add('active');

        // Load tab content if not already loaded
        if (!loadedTabs[tab.id]) {
          loadTabContent(tab, data);
        } else {
          // Resize charts in newly visible panel
          Object.values(Chart.instances).forEach(function(c) { c.resize(); });
        }
      });
    });

    function loadTabContent(tab, dashData) {
      // Determine which template folder to fetch
      var templateName = tab.template || tab.id;

      loadTabTemplate(templateName)
        .then(function(templateHtml) {
          var panel = document.getElementById('dt-' + tab.id);
          if (!panel) return;

          // Inject the template HTML
          panel.innerHTML = templateHtml;

          // Determine tab data: base tabs use baseTabs.{key}, addon tabs use addonTabs.{template}
          var tabData = null;
          if (tab.type === 'base') {
            var bt = dashData.baseTabs || {};
            if (tab.id === 'total-market') tabData = bt.totalMarket || null;
            else if (tab.id === 'market-structure') tabData = bt.marketStructure || null;
            else if (tab.id === 'reviews') tabData = bt.reviews || null;
          } else {
            var at = dashData.addonTabs || {};
            tabData = at[templateName] || null;
          }

          // Set data on window for the template's script to pick up
          console.log('[hub] Loading tab:', tab.id, 'type:', tab.type, 'tabData:', tabData ? 'has data (' + Object.keys(tabData).join(',') + ')' : 'NULL');
          window._TAB_DATA = tabData;
          window._DASH_DATA = dashData; // full dashboard data incl. _computed from CSV

          // Execute any <script> tags in the injected template
          panel.querySelectorAll('script').forEach(function(oldScript) {
            var newScript = document.createElement('script');
            if (oldScript.src) {
              newScript.src = oldScript.src;
            } else {
              newScript.textContent = oldScript.textContent;
            }
            oldScript.parentNode.replaceChild(newScript, oldScript);
          });

          loadedTabs[tab.id] = true;

          // Clean up tab-specific data (but keep _DASH_DATA — other tabs need it)
          window._TAB_DATA = null;
        })
        .catch(function(err) {
          console.error('Failed to load tab:', tab.id, err);
          var panel = document.getElementById('dt-' + tab.id);
          if (panel) {
            panel.innerHTML = '<div class="card"><h3>' + tab.label + '</h3>' +
              '<p style="color:#dc2626;font-size:.85rem">Failed to load tab template: ' + (tab.template || tab.id) + '</p></div>';
          }
          loadedTabs[tab.id] = true;
        });
    }
  }

  // ── UI helpers ──
  function showLoading(on) {
    document.getElementById('loading').style.display = on ? 'flex' : 'none';
    if (on) {
      document.getElementById('dashboardContainer').style.display = 'none';
      document.getElementById('emptyState').style.display = 'none';
    }
  }

  function showError(msg) {
    var container = document.getElementById('dashboardContainer');
    var emptyState = document.getElementById('emptyState');
    emptyState.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626"><p style="font-size:.9rem;font-weight:500">' + msg + '</p></div>';
  }

  // ── Mobile sidebar toggle ──
  document.getElementById('sidebarToggle').addEventListener('click', function() {
    document.getElementById('sidebar').classList.toggle('open');
  });

})();
