(() => {
  const API = window.APP_CONFIG.apiUrl;
  const KEY_STORE = 'kashikari.key';
  const $app = document.getElementById('app');
  const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
  const today = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    kids.flat().forEach(k => k != null && el.append(k));
    return el;
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---- キー（自分用/相手用リンクの ?k=） ----

  function loadKey() {
    const k = new URLSearchParams(location.search).get('k');
    if (k) { storeKey(k); return k; }
    try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }
  function storeKey(k) {
    try { localStorage.setItem(KEY_STORE, k); } catch (e) {}
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  let key = loadKey();

  async function api(action, payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ k: key, action: action }, payload || {})),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }

  async function run(action, payload, msgEl) {
    try {
      render(await api(action, payload));
    } catch (err) {
      if (err.message === 'リンクが正しくありません') { clearKey(); key = ''; showKeyForm(err.message); return; }
      const text = err instanceof TypeError ? '通信できません。電波を確認してください' : err.message;
      if (msgEl) msgEl.textContent = text; else showError(text);
    }
  }

  // ---- 画面 ----

  function showError(text) {
    $app.replaceChildren(h('div', { className: 'card' },
      h('div', { className: 'msg', textContent: text }),
      h('button', { className: 'primary', textContent: '再読み込み', onclick: () => run('get') })));
  }

  // ホーム画面から開いてキーが見つからないとき用
  function showKeyForm(err) {
    const input = h('input', { type: 'url', placeholder: '受け取ったリンクを貼り付け' });
    const msg = h('div', { className: 'msg', textContent: err || '' });
    $app.replaceChildren(h('div', { className: 'card' },
      h('div', { className: 'label', textContent: '最初に受け取ったリンクを貼り付けてください', style: 'margin-bottom:8px' }),
      input, msg,
      h('button', {
        className: 'primary', textContent: '開く', onclick: () => {
          const v = input.value.trim();
          let k = v;
          try { k = new URL(v).searchParams.get('k') || v; } catch (e) {}
          if (!k) { msg.textContent = 'リンクを貼り付けてください'; return; }
          key = k; storeKey(k); run('get');
        },
      })));
  }

  function render(d) {
    $app.replaceChildren(...(d.role === 'owner' ? ownerView(d) : staffView(d)));
  }

  // 自分の画面：登録・全履歴・与信枠
  function ownerView(d) {
    const over = d.limit > 0 && d.balance > d.limit;
    const pct = d.limit > 0 ? Math.min(100, Math.max(0, d.balance / d.limit * 100)) : 0;
    const summary = h('div', { className: 'card' + (over ? ' over' : '') },
      h('div', { className: 'label', textContent: d.staffName + 'さんへの貸付残高' }),
      h('div', { className: 'balance', textContent: yen(d.balance) }),
      d.limit > 0 ? [
        h('div', { className: 'bar' }, h('div', { style: 'width:' + pct + '%' })),
        h('div', { className: 'small', textContent: '与信枠 ' + yen(d.limit) }),
      ] : null,
      over ? h('div', { className: 'warn', textContent: '与信枠を超えています' }) : null,
      pendingNote(d),
      !over && d.limit > 0 && d.balance + d.pendingLend > d.limit
        ? h('div', { className: 'warn', textContent: '確認待ちの貸付を含めると与信枠を超えます' }) : null);

    let type = '貸付';
    const btnLend = h('button', { textContent: '貸した' });
    const btnRepay = h('button', { textContent: '返済してもらった' });
    const date = h('input', { type: 'date', value: today() });
    const amount = h('input', { type: 'number', inputMode: 'numeric', min: 1, placeholder: '金額（円）' });
    const memo = h('input', { type: 'text', maxLength: 200, placeholder: 'メモ（自分だけに見えます）' });
    const msg = h('div', { className: 'msg' });
    const save = h('button', { className: 'primary' });
    const paint = () => {
      btnLend.classList.toggle('on', type === '貸付');
      btnRepay.classList.toggle('on', type === '返済');
      save.textContent = type === '貸付' ? '貸付を登録' : '返済してもらいました';
    };
    btnLend.onclick = () => { type = '貸付'; paint(); };
    btnRepay.onclick = () => { type = '返済'; paint(); };
    paint();
    save.onclick = async () => {
      if (!(Number(amount.value) > 0)) { msg.textContent = '金額を入力してください'; return; }
      save.disabled = true;
      await run('add', { type: type, date: date.value, amount: Number(amount.value), memo: memo.value }, msg);
      save.disabled = false;
    };
    const form = h('div', { className: 'card' },
      h('div', { className: 'seg' }, btnLend, btnRepay), date, amount, memo, msg, save);

    const list = d.items.map(it => {
      let status = '';
      if (it.voided) status = '取消済み';
      else status = it.confirmed ? '相手確認済み ✓（' + it.confirmed + '）' : '相手確認待ち（残高に未反映）';
      const actions = h('div');
      if (!it.voided) {
        // 誤タップ防止に2回押しで取消
        const b = h('button', { className: 'mini danger', textContent: '取消' });
        b.onclick = () => {
          if (b.dataset.armed) { b.disabled = true; run('void', { id: it.id }); return; }
          b.dataset.armed = '1';
          b.textContent = 'もう一度押す';
          setTimeout(() => { delete b.dataset.armed; b.textContent = '取消'; }, 3000);
        };
        actions.append(b);
      }
      return h('div', { className: 'item' + (it.voided ? ' voided' : '') },
        h('div', { className: 'row' },
          h('div', {},
            h('span', { className: it.type === '貸付' ? 't-lend' : 't-repay', textContent: it.type === '貸付' ? '貸付' : '返済' }),
            h('span', { className: 'amt', textContent: ' ' + yen(it.amount) })),
          actions),
        h('div', { className: 'small', textContent: it.date + (status ? '　' + status : '') }),
        it.memo ? h('div', { className: 'small', textContent: it.memo }) : null);
    });

    return [summary, form, historyCard(list)];
  }

  // スタッフの画面：借りた日・返済状況・残高だけ。記録は1件ずつ確認してもらう
  function staffView(d) {
    const out = [];
    const pending = d.items.filter(it => !it.confirmed);
    if (pending.length) {
      const msg = h('div', { className: 'msg' });
      const rows = pending.map(it => {
        const btn = h('button', { className: 'mini', textContent: '確認しました' });
        btn.onclick = async () => {
          btn.disabled = true;
          await run('confirm', { id: it.id }, msg);
          btn.disabled = false;
        };
        return h('div', { className: 'item' },
          h('div', { className: 'row' },
            h('div', {},
              h('span', { className: it.type === '貸付' ? 't-lend' : 't-repay', textContent: it.type === '貸付' ? '借りた' : '返済' }),
              h('span', { className: 'amt', textContent: ' ' + yen(it.amount) })),
            btn),
          h('div', { className: 'small', textContent: it.date }));
      });
      out.push(h('div', { className: 'card notice' },
        h('div', { className: 'big', textContent: '確認をお願いします（' + pending.length + '件）' }),
        h('div', { className: 'small', textContent: '内容が合っていたら「確認しました」を押してください。違うときは' + d.ownerName + 'さんに伝えてください。確認すると残高に反映されます。' }),
        rows, msg));
    }

    out.push(h('div', { className: 'card' },
      h('div', { className: 'label', textContent: d.ownerName + 'さんからの借入残高' }),
      h('div', { className: 'balance', textContent: yen(d.balance) }),
      pendingNote(d),
      d.balance <= 0 && !pending.length ? h('div', { className: 'small ok', textContent: '完済しています' }) : null));

    const list = d.items.map(it => h('div', { className: 'item' },
      h('div', {},
        h('span', { className: it.type === '貸付' ? 't-lend' : 't-repay', textContent: it.type === '貸付' ? '借りた' : '返済' }),
        h('span', { className: 'amt', textContent: ' ' + yen(it.amount) })),
      h('div', { className: 'small', textContent: it.date + (it.confirmed ? '　確認済み ✓' : '　未確認') })));

    out.push(historyCard(list));
    return out;
  }

  // 残高の下に出す「確認待ち」の合計
  function pendingNote(d) {
    const parts = [];
    if (d.pendingLend) parts.push((d.role === 'owner' ? '貸付 ' : '借りた ') + yen(d.pendingLend));
    if (d.pendingRepay) parts.push('返済 ' + yen(d.pendingRepay));
    return parts.length ? h('div', { className: 'small', textContent: '確認待ち：' + parts.join(' ／ ') + '（残高に未反映）' }) : null;
  }

  function historyCard(list) {
    return h('div', { className: 'card' },
      h('div', { className: 'label', textContent: '履歴', style: 'margin-bottom:4px' }),
      list.length ? list : h('div', { className: 'small', textContent: 'まだ記録はありません' }));
  }

  if (key) run('get'); else showKeyForm();
})();
