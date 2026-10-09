/* Team controls use the existing API/toast/design helpers from index.html. */
function teamDialog(title, fields, submitLabel = 'Сохранить') {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'team-dialog';
    d.innerHTML = `<form><h3>${escapeHtml(title)}</h3>${fields}<div class="team-actions section-gap"><button class="btn btn-primary" type="submit">${escapeHtml(submitLabel)}</button><button class="btn btn-ghost" type="button" data-cancel>Отмена</button></div></form>`;
    let finished = false;
    const finish = value => { if (finished) return; finished=true; d.close(); d.remove(); resolve(value); };
    d.querySelector('form').onsubmit = e => { e.preventDefault(); finish(Object.fromEntries(new FormData(e.target))); };
    d.querySelector('[data-cancel]').onclick = () => finish(null);
    d.oncancel = e => { e.preventDefault(); finish(null); };
    document.body.append(d); d.showModal();
  });
}

function adminOptions(selected, omitId) {
  return '<option value="">Главный админ</option>' + allAdmins.filter(a => !a.isSuperAdmin && a.id !== omitId && a.status === 'active')
    .map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${escapeHtml(a.firstName)} (${escapeHtml(a.email)})</option>`).join('');
}

document.getElementById('claim-partner-open').onclick = async () => {
  const input = await teamDialog('Найти незакреплённого партнёра', '<p class="team-note">Партнёр должен уже иметь аккаунт. Введите точный email, с которым он зарегистрировался.</p><div class="field"><label>Email партнёра</label><input class="input" type="email" name="email" autocomplete="off" required></div>', 'Найти');
  if (!input) return;
  try {
    const p = await api('/admin/partners/unassigned?email='+encodeURIComponent(input.email.trim()));
    const admins = await api('/admin/admins');
    const choices = admins.filter(a=>a.status==='active').map(a=>`<option value="${a.id}" ${a.id===currentAdminMe.id?'selected':''}>${a.id===currentAdminMe.id?'Я — ':''}${escapeHtml(a.firstName)} (${escapeHtml(a.email)})</option>`).join('');
    const confirm = await teamDialog('Закрепить партнёра', `<p><strong>${escapeHtml([p.firstName,p.lastName].filter(Boolean).join(' '))}</strong><br>${escapeHtml(p.email)}</p><p class="team-note">Сейчас ответственный менеджер не назначен.</p><div class="field"><label>Кому назначить</label><select class="input" name="adminId" required>${choices}</select></div>`, 'Закрепить');
    if (!confirm) return;
    const r = await api('/admin/partners/claim',{method:'POST',body:{email:p.email,adminId:Number(confirm.adminId)}});
    await loadPartners();
    showToast('Партнёр закреплён за выбранным менеджером','success');
    await openPartnerDetail(r.partnerId);
  } catch(e) { showToast(e.message,'error'); }
};

async function loadAdmins() {
  const body = document.getElementById('admins-body');
  try {
    allAdmins = await api('/admin/admins');
    document.getElementById('new-admin-parent-field').classList.toggle('hidden', !isSuperAdmin);
    document.getElementById('new-admin-parent').innerHTML = adminOptions(null);
    body.innerHTML = allAdmins.map(a => {
      const self = a.id === currentAdminMe.id;
      const ref = location.origin + '/?ref=' + encodeURIComponent(a.refSlug);
      const editable = !self && !a.isSuperAdmin;
      return `<tr><td>${escapeHtml(a.firstName)} ${escapeHtml(a.lastName || '')}${self ? ' <span class="team-tag">Вы</span>' : ''}<div class="team-tag">Команда: ${a.teamCount}</div></td>
        <td class="td-dim">${escapeHtml(a.email)}</td><td>${a.isSuperAdmin ? 'Главный админ' : 'Менеджер / тимлид'}<div class="team-note">Руководитель: ${a.isSuperAdmin ? '—' : escapeHtml(a.teamLeadName)}</div>${isSuperAdmin && editable ? `<button class="btn btn-ghost btn-sm" data-team-parent="${a.id}">Назначить тимлида</button>` : ''}</td>
        <td>${a.partnerCount}</td><td><div class="team-link-list">${escapeHtml(ref)}</div><button class="btn btn-ghost btn-sm" data-copy-ref="${escapeHtml(ref)}">Копировать</button>${isSuperAdmin ? `<button class="btn btn-ghost btn-sm" data-slug="${a.id}">Алиас</button>` : ''}</td>
        <td><div class="team-link-list">${a.effectivePayoutUrls.map(escapeHtml).join('<br>') || 'Не настроены'}</div><div class="team-tag">${a.payoutInherited ? 'Наследуются: ' + escapeHtml(a.payoutSourceName) : 'Индивидуальные ссылки'}</div>${isSuperAdmin ? `<button class="btn btn-ghost btn-sm" data-payout="${a.id}">Изменить / добавить</button>` : '<span class="team-note">Изменяет главный админ</span>'}</td>
        <td><span class="badge ${a.status === 'active' ? 'badge-success' : 'badge-danger'}">${a.status === 'active' ? 'Активен' : 'Заблокирован'}</span></td>
        <td>${editable ? `<div class="team-actions"><button class="btn btn-ghost btn-sm" data-block="${a.id}">${a.status === 'active' ? 'Заблокировать' : 'Разблокировать'}</button><button class="btn btn-ghost btn-sm" data-password="${a.id}">Сменить пароль</button></div>` : ''}</td></tr>`;
    }).join('');
    const labels = [...document.querySelectorAll('#tab-admins th')].map(x=>x.textContent || 'Действия');
    body.querySelectorAll('tr').forEach(row=>[...row.children].forEach((td,i)=>td.dataset.label=labels[i]));
    body.querySelectorAll('[data-copy-ref]').forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copyRef); showToast('Ссылка скопирована','success'); } catch { showToast('Не удалось скопировать','error'); }
    });
    body.querySelectorAll('[data-block]').forEach(b => b.onclick = async () => {
      const a = allAdmins.find(x => x.id === Number(b.dataset.block));
      if (!confirm(`${a.status === 'active' ? 'Заблокировать' : 'Разблокировать'} ${a.firstName}?`)) return;
      try { await api(`/admin/admins/${a.id}/status`,{method:'PUT',body:{status:a.status==='active'?'blocked':'active'}}); await loadAdmins(); showToast('Статус обновлён','success'); } catch(e) { showToast(e.message,'error'); }
    });
    body.querySelectorAll('[data-password]').forEach(b => b.onclick = async () => {
      const v = await teamDialog('Новый пароль менеджера','<div class="field"><label>Пароль (минимум 8 символов)</label><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label>Повторите пароль</label><input class="input" name="repeat" type="password" autocomplete="new-password" minlength="8" required></div><p class="team-note">Все старые сеансы менеджера завершатся.</p>');
      if (!v) return;
      if (v.password !== v.repeat) return showToast('Пароли не совпадают','error');
      try { await api(`/admin/admins/${b.dataset.password}/reset-password`,{method:'POST',body:{password:v.password}}); showToast('Пароль изменён','success'); } catch(e) { showToast(e.message,'error'); }
    });
    body.querySelectorAll('[data-team-parent]').forEach(b => b.onclick = async () => {
      const a = allAdmins.find(x => x.id === Number(b.dataset.teamParent));
      const v = await teamDialog('Назначить руководителя',`<div class="field"><label>Тимлид</label><select class="input" name="teamLeadId">${adminOptions(a.teamLeadId,a.id)}</select></div><p class="team-note">Вместе с менеджером переносится его команда. Ссылки без индивидуальной настройки будут наследоваться от нового тимлида.</p>`);
      if (!v) return;
      try { await api(`/admin/admins/${a.id}/team-lead`,{method:'PUT',body:{teamLeadId:v.teamLeadId ? Number(v.teamLeadId) : null}}); await loadAdmins(); } catch(e) { showToast(e.message,'error'); }
    });
    body.querySelectorAll('[data-payout]').forEach(b => b.onclick = async () => {
      const a = allAdmins.find(x => x.id === Number(b.dataset.payout));
      const v = await teamDialog('Ссылки на способ выплаты',`<p class="team-note">По одной HTTPS-ссылке на строку. Первая — основная. Пустое поле возвращает наследование от руководителя; у главного админа — из настроек сайта.</p><textarea class="input" name="urls" aria-label="Ссылки выплат">${escapeHtml(a.payoutUrls.join('\n'))}</textarea>`);
      if (!v) return;
      try { await api(`/admin/admins/${a.id}/payout-url`,{method:'PUT',body:{urls:v.urls.split('\n').map(x=>x.trim()).filter(Boolean)}}); await loadAdmins(); showToast('Ссылки сохранены','success'); } catch(e) { showToast(e.message,'error'); }
    });
    body.querySelectorAll('[data-slug]').forEach(b => b.onclick = async () => {
      const a = allAdmins.find(x => x.id === Number(b.dataset.slug));
      const v = await teamDialog('Алиас реферальной ссылки',`<input class="input" name="slug" value="${escapeHtml(a.refSlug)}" required>`);
      if (!v) return;
      try { await api(`/admin/admins/${a.id}/slug`,{method:'PUT',body:v}); await loadAdmins(); } catch(e) { showToast(e.message,'error'); }
    });
  } catch(e) { body.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`; }
}

function actionLabel(action) {
  const p = action.replace(/^(POST|PUT|DELETE) /,'');
  const names = {'/partners/claim':'Закрепил партнёра по email','/partners/:id/owner':'Перевёл партнёра другому менеджеру','/report/activity':'Сохранил дневной отчёт','/report/profit':'Добавил профит','/report/profit/:id':action.startsWith('DELETE')?'Удалил профит':'Исправил профит','/admins':'Добавил менеджера','/admins/:id/status':'Изменил статус менеджера','/admins/:id/reset-password':'Сменил пароль менеджера','/admins/:id/team-lead':'Изменил тимлида','/admins/:id/payout-url':'Обновил ссылки выплат','/partners/:id/credit':'Начислил баланс партнёру','/partners/:id/messages':'Написал партнёру','/partners/:id/status':'Изменил статус партнёра','/partners/:id/reset-password':'Сбросил пароль партнёра','/partners/:id/payout-url':'Выбрал ссылку выплаты','/partners/:id/telegram':'Настроил Telegram партнёра','/partners/:id/telegram/test':'Проверил Telegram партнёра','/partners/:id/telegram/rotate-key':'Обновил ключ постбеков'};
  return names[p] || 'Изменение в кабинете';
}

async function loadStats() {
  const date = document.getElementById('st-date');
  if (!date.value) date.value = todayStr();
  const body = document.getElementById('st-body');
  try {
    const data = await api('/admin/stats/daily?date='+encodeURIComponent(date.value));
    document.getElementById('st-timezone').textContent = `Дата отчёта: ${data.date} · ${data.timezone}. Telegram и группы — данные менеджера. Действия в кабинете записываются автоматически.`;
    document.getElementById('st-profits').innerHTML = [['День',data.profits.day],['Неделя',data.profits.week],['Месяц',data.profits.month],['Всё время',data.profits.allTime]].map(([title,value])=>`<div class="kpi-card"><div class="lbl">Профит команды · ${title}</div><div class="val">$${fmtMoney(value)}</div></div>`).join('');
    document.getElementById('st-summary').textContent = `Менеджеров: ${data.admins.length} · Сдали отчёт: ${data.admins.filter(a=>a.reportSubmitted).length} · Профит: $${fmtMoney(data.admins.reduce((s,a)=>s+a.dayProfitTotal,0))}`;
    body.innerHTML = data.admins.map(a => `<tr><td>${escapeHtml(a.name || a.email)}${a.adminId===currentAdminMe.id?' (вы)':''}<div class="team-note">${escapeHtml(a.email)}</div></td><td>${a.registrations}</td><td>${a.partnersCredited}</td><td>${a.tgPosts}</td><td>${a.groupsCreated}</td><td><span class="badge ${a.reportSubmitted?'badge-success':'badge-warning'}">${a.reportSubmitted?'Сдан':'Не сдан'}</span></td><td><details><summary>${a.actionsToday} действий</summary><ul class="team-log">${a.recentActions.map(x=>`<li>${escapeHtml(actionLabel(x.action))}${x.target?' · #'+escapeHtml(x.target):''}<br>${escapeHtml(fmtDate(x.createdAt))}</li>`).join('') || '<li>Нет действий</li>'}</ul></details></td><td class="td-emerald"><details><summary>$${fmtMoney(a.dayProfitTotal)}</summary><ul class="team-log">${a.dayProfitEntries.map(e=>`<li>${escapeHtml(e.partnerTg)}: $${fmtMoney(e.amount)}</li>`).join('') || '<li>Нет записей</li>'}</ul></details></td></tr>`).join('');
  } catch(e) { body.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`; }
}

async function loadManagerFinance() {
  const date = document.getElementById('fin-managers-date').value;
  try {
    const data = await api('/admin/finance/managers'+(date?'?date='+encodeURIComponent(date):''));
    const body = document.getElementById('fin-managers-body');
    body.innerHTML = data.managers.map(a=>`<tr><td>${escapeHtml(a.name)}<div class="team-note">${escapeHtml(a.email)}</div></td><td>$${fmtMoney(a.income)}</td><td>$${fmtMoney(a.managerShare)}</td><td>$${fmtMoney(a.gatewayCost)}</td><td>$${fmtMoney(a.entryExpenses)}</td><td>$${fmtMoney(a.managerExpenses)}</td><td>$${fmtMoney(a.expenses)}</td><td style="color:${a.netProfit<0?'var(--red,#f66)':'var(--gold)'}">$${fmtMoney(a.netProfit)}</td></tr>`).join('');
    document.getElementById('fin-manager-totals').textContent = `Доход $${fmtMoney(data.totals.income)} · Расходы по менеджерам $${fmtMoney(data.totals.expenses)} · Общие нераспределённые расходы $${fmtMoney(data.unallocatedExpenses)} · Компании чисто $${fmtMoney(data.companyNetProfit)}`;
    const selected = document.getElementById('fin-exp-admin').value;
    document.getElementById('fin-exp-admin').innerHTML = '<option value="">Общий расход компании</option>'+data.managers.map(a=>`<option value="${a.adminId}">${escapeHtml(a.name)} (${escapeHtml(a.email)})</option>`).join('');
    document.getElementById('fin-exp-admin').value = selected;
  } catch(e) { showToast(e.message,'error'); }
}
document.getElementById('fin-managers-date').onchange = loadManagerFinance;
document.getElementById('fin-managers-all').onclick = () => { document.getElementById('fin-managers-date').value=''; loadManagerFinance(); };

const TG_EVENT_NAMES = {registration:'Регистрация',ftd:'Первый депозит',repeat:'Повторный депозит',reject:'Отклонение'};
const TG_STATUS_NAMES = {sent:'Доставлено',failed:'Ошибка',pending:'В очереди',sending:'Отправляется',skipped:'Отключено'};
async function loadPartnerTelegram(id) {
  const box = document.getElementById('pd-telegram');
  box.innerHTML = '<p class="team-note">Загрузка Telegram…</p>';
  try {
    const d = await api(`/admin/partners/${id}/telegram`);
    if (currentPartnerId !== id) return;
    box.innerHTML = `<details><summary>Telegram-постбеки партнёра</summary>
      <p class="team-note">Отдельный чат для событий этого партнёра. <a class="team-guide" href="/admin/team-guide.html#telegram" target="_blank" rel="noopener">Полная инструкция</a></p>
      <p class="tg-status">Бот: ${escapeHtml(d.botSource)} · ${d.hasEffectiveBot?'настроен':'не настроен'}</p>
      <div class="checkbox-row"><input type="checkbox" id="ptg-enabled" ${d.enabled?'checked':''}><label for="ptg-enabled">Отправлять события в Telegram</label></div>
      <div class="team-grid section-gap"><div class="field"><label for="ptg-token">Токен отдельного бота (необязательно)</label><input class="input" type="password" id="ptg-token" autocomplete="new-password" placeholder="${d.hasCustomBot?'Сохранён. Пустое поле — без изменений':'Пусто — использовать бота руководителя'}"></div><div class="field"><label for="ptg-chat">Chat ID партнёра / группы</label><input class="input" id="ptg-chat" value="${escapeHtml(d.chatId)}" placeholder="-1001234567890"></div></div>
      <div class="checkbox-row"><input type="checkbox" id="ptg-clear"><label for="ptg-clear">Убрать отдельного бота и использовать бота руководителя</label></div>
      <div class="team-actions section-gap">${Object.entries(TG_EVENT_NAMES).map(([k,v])=>`<label class="checkbox-row"><input type="checkbox" data-tg-event="${k}" ${d.events.includes(k)?'checked':''}>${v}</label>`).join('')}</div>
      <div class="team-actions section-gap"><button class="btn btn-primary btn-sm" id="ptg-save">Сохранить настройки</button><button class="btn btn-ghost btn-sm" id="ptg-test">Отправить тест по сохранённым настройкам</button></div>
      <p class="team-note" id="ptg-result" role="status"></p>
      <details class="section-gap"><summary>Ссылка для трекера и ключ</summary><p class="team-note">Замените макросы на макросы вашего трекера. event_id должен быть уникальным ID конверсии. Ключ даёт право отправлять события этого партнёра — передавайте его только доверенному источнику.</p><textarea class="input team-code" readonly rows="5" aria-label="URL постбека" id="ptg-url"></textarea><div class="team-actions"><button class="btn btn-ghost btn-sm" id="ptg-copy">Копировать URL</button><button class="btn btn-ghost btn-sm" id="ptg-rotate">Сменить ключ</button></div></details>
      <p class="team-note">Последние 50 событий. Постбеки не меняют баланс и финансовый отчёт.</p><div class="table-wrap"><table><thead><tr><th>Время / событие</th><th>ID</th><th>Доставка</th><th></th></tr></thead><tbody>${d.logs.map(x=>`<tr><td>${escapeHtml(fmtDate(x.createdAt))}<br>${escapeHtml(TG_EVENT_NAMES[x.event])}</td><td>${escapeHtml(x.eventId)}</td><td>${escapeHtml(TG_STATUS_NAMES[x.status] || x.status)}<div class="team-note">${escapeHtml(x.error || '')}</div></td><td>${['failed','pending','sending'].includes(x.status)?`<button class="btn btn-ghost btn-sm" data-tg-retry="${x.id}">Повторить</button>`:''}</td></tr>`).join('') || '<tr><td colspan="4">Событий пока нет</td></tr>'}</tbody></table></div><button class="btn btn-ghost btn-sm" id="ptg-refresh">Обновить журнал</button>
    </details>`;
    document.getElementById('ptg-url').value = d.templateUrl;
    document.getElementById('ptg-copy').onclick = async () => { try { await navigator.clipboard.writeText(d.templateUrl); showToast('URL скопирован','success'); } catch { showToast('Выделите и скопируйте URL вручную','error'); } };
    const run = async (fn, message) => { try { await fn(); showToast(message,'success'); await loadPartnerTelegram(id); box.querySelector('details').open=true; } catch(e) { document.getElementById('ptg-result').textContent=e.message; showToast(e.message,'error'); } };
    document.getElementById('ptg-save').onclick = () => run(()=>api(`/admin/partners/${id}/telegram`,{method:'PUT',body:{enabled:document.getElementById('ptg-enabled').checked,botToken:document.getElementById('ptg-token').value,chatId:document.getElementById('ptg-chat').value,clearBot:document.getElementById('ptg-clear').checked,events:[...box.querySelectorAll('[data-tg-event]:checked')].map(x=>x.dataset.tgEvent)}}),'Telegram сохранён');
    document.getElementById('ptg-test').onclick = () => run(()=>api(`/admin/partners/${id}/telegram/test`,{method:'POST'}),'Тест доставлен');
    document.getElementById('ptg-rotate').onclick = () => { if(confirm('Старый URL перестанет работать. После смены обновите ключ в трекере. Продолжить?')) run(()=>api(`/admin/partners/${id}/telegram/rotate-key`,{method:'POST'}),'Ключ обновлён'); };
    box.querySelectorAll('[data-tg-retry]').forEach(b=>b.onclick=()=>run(()=>api(`/admin/partners/${id}/telegram/retry/${b.dataset.tgRetry}`,{method:'POST'}),'Отправка обработана'));
    document.getElementById('ptg-refresh').onclick = () => run(async()=>{},'Журнал обновлён');
  } catch(e) { box.textContent=e.message; }
}

// Start only after all team UI functions are loaded.
(async function initTeamAdmin(){
  try { const me=await api('/me'); if(me.role!=='admin') throw new Error('Admin only'); await enterAdmin(); }
  catch { document.getElementById('login-screen').classList.remove('hidden'); }
})();
