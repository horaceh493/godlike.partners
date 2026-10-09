const db = require('../db');
const { teamIds, canManagePartner } = require('./team');

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }

// Both claims and transfers validate fresh ownership while holding a write
// transaction, so two teams cannot claim the same unassigned partner.
function assignOwner(actor, partnerId, adminId, claimOnly = false) {
  const ownerId = adminId === null || adminId === '' ? null : Number(adminId);
  if (ownerId !== null && (!Number.isSafeInteger(ownerId) || ownerId < 1)) fail(400,'Выберите менеджера.');
  if (ownerId === null && (claimOnly || !actor.is_super_admin)) fail(400,'Выберите себя или менеджера своей команды.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const partner = db.prepare("SELECT * FROM users WHERE id=? AND role='partner'").get(partnerId);
    if (!partner) fail(404,'Партнёр не найден.');
    if (claimOnly) {
      if (partner.owner_admin_id !== null) fail(409,'Партнёр уже закреплён. Внутри своей команды используйте его карточку; для другой команды обратитесь к главному админу.');
    } else if (!canManagePartner(actor,partner)) {
      fail(403,'Переводить можно только партнёров своей команды. Незакреплённого партнёра найдите по email.');
    }
    if (ownerId !== null) {
      const dest = db.prepare("SELECT id,status FROM users WHERE id=? AND role='admin'").get(ownerId);
      if (!dest || dest.status !== 'active') fail(400,'Выберите активного менеджера.');
      if (!actor.is_super_admin && !teamIds(actor).includes(ownerId)) fail(403,'Назначить можно только себе или менеджеру своей команды.');
    }
    const changed = partner.owner_admin_id !== ownerId;
    if (changed) {
      db.prepare('UPDATE users SET owner_admin_id=? WHERE id=?').run(ownerId,partner.id);
      db.prepare('INSERT INTO partner_owner_history(partner_id,actor_id,from_admin_id,to_admin_id,reason) VALUES(?,?,?,?,?)')
        .run(partner.id,actor.id,partner.owner_admin_id,ownerId,claimOnly?'manual_claim':'manual_transfer');
    }
    db.exec('COMMIT');
    return {ok:true,partnerId:partner.id,ownerAdminId:ownerId,changed};
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { assignOwner };
