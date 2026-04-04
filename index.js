require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActivityType, REST, Routes, SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const SALT_ROUNDS = 10;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers   // ← necesario para buscar miembros
    ]
});
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const PORT              = process.env.PORT             || 3000;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const SECRET_KEY        = process.env.SECRET_KEY       || 'tilted2025';
const CHANNEL_SANCIONES = process.env.CHANNEL_SANCIONES;
const CHANNEL_SS        = process.env.CHANNEL_SS;
const CHANNEL_ROLLBACKS = process.env.CHANNEL_ROLLBACKS;
const CHANNEL_MUTES     = process.env.CHANNEL_MUTES;
const CLIENT_ID         = process.env.CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const REDIS_URL         = process.env.REDIS_URL;
const ADMIN_DISCORD_ID  = process.env.ADMIN_DISCORD_ID;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI;

// ── Redis ──────────────────────────────────────────────────────────────────
let redis = null;
async function connectRedis() {
    if (!REDIS_URL) { console.log('Sin Redis'); return; }
    redis = createClient({ url: REDIS_URL });
    redis.on('error', e => console.error('Redis:', e.message));
    await redis.connect();
    console.log('Redis conectado');
}

// ── Users en servidor ─────────────────────────────────────────────────────
const USERS_KEY = 'sp:users';

async function getServerUsers() {
    if (redis) {
        const raw = await redis.get(USERS_KEY);
        if (raw) return JSON.parse(raw);
        // Primera vez — crear admin con hash real
        const hash = await bcrypt.hash('admin123', SALT_ROUNDS);
        const defaults = [{ username: 'admin', password: hash, role: 'admin', discordId: '' }];
        await redis.set(USERS_KEY, JSON.stringify(defaults));
        return defaults;
    } else {
        if (!global.spUsers) {
            const hash = await bcrypt.hash('admin123', SALT_ROUNDS);
            global.spUsers = [{ username: 'admin', password: hash, role: 'admin', discordId: '' }];
        }
        return global.spUsers;
    }
}

async function saveServerUsers(users) {
    if (redis) {
        await redis.set(USERS_KEY, JSON.stringify(users));
    } else {
        global.spUsers = users;
    }
}

// ── Periodo keys ───────────────────────────────────────────────────────────
function getWeekKey(tipo) {
    const n = new Date(), jan = new Date(n.getFullYear(),0,1);
    const w = Math.ceil(((n-jan)/86400000+jan.getDay()+1)/7);
    return `lb:${tipo}:week:${n.getFullYear()}:${w}`;
}
function getMonthKey(tipo) {
    const n = new Date();
    return `lb:${tipo}:month:${n.getFullYear()}:${n.getMonth()+1}`;
}
function ttlWeek() {
    const n=new Date(), s=new Date(n);
    s.setDate(n.getDate()+(7-n.getDay())); s.setHours(23,59,59,0);
    return Math.max(1, Math.floor((s-n)/1000));
}
function ttlMonth() {
    const n=new Date(), l=new Date(n.getFullYear(),n.getMonth()+1,0,23,59,59);
    return Math.max(1, Math.floor((l-n)/1000));
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function addStat(staff, tipo) {
    if (!staff || !tipo) return;
    const isSSCat = ['ss','ss-appeal','ss-clean','ss-notes'].includes(tipo);
    const cat   = isSSCat ? 'ss' : 'normal';
    const field = `${staff}:${tipo}`;
    if (redis) {
        await redis.hIncrBy(getWeekKey(cat),  field, 1); await redis.expire(getWeekKey(cat),  ttlWeek());
        await redis.hIncrBy(getMonthKey(cat), field, 1); await redis.expire(getMonthKey(cat), ttlMonth());
    } else {
        if (!global.lbMem) global.lbMem = {};
        ['week','month'].forEach(p => {
            const k = `${cat}_${p}`;
            if (!global.lbMem[k]) global.lbMem[k] = {};
            global.lbMem[k][field] = (global.lbMem[k][field]||0)+1;
        });
    }
}

async function getLB(cat, periodo) {
    const key = periodo === 'week' ? getWeekKey(cat) : getMonthKey(cat);
    let raw = {};
    if (redis) { raw = await redis.hGetAll(key) || {}; }
    else { raw = (global.lbMem||{})[`${cat}_${periodo}`] || {}; }
    const result = {};
    for (const [field, val] of Object.entries(raw)) {
        const idx   = field.indexOf(':');
        const staff = field.slice(0, idx);
        const tipo  = field.slice(idx+1);
        if (!result[staff]) result[staff] = {};
        result[staff][tipo] = (result[staff][tipo]||0) + (parseInt(val)||0);
    }
    return result;
}

// ── Auth ───────────────────────────────────────────────────────────────────
function auth(req, res, next) {
    if (req.headers['x-api-key'] !== SECRET_KEY) return res.status(401).json({ error: 'No autorizado' });
    next();
}
function s(v) { return (!v || String(v).trim() === '') ? '—' : String(v).slice(0,1024); }

// ── Base64 → Attachment ────────────────────────────────────────────────────
function toAttachment(b64, i) {
    try {
        const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!m) return null;
        return new AttachmentBuilder(Buffer.from(m[2],'base64'), { name:`prueba_${i+1}.${m[1]}` });
    } catch(e) { return null; }
}

// ── Discord ID map — staffUsername → discordId ─────────────────────────────
const DISCORD_MAP_KEY = 'discord:map';

async function getDiscordMap() {
    if (redis) {
        const raw = await redis.hGetAll(DISCORD_MAP_KEY) || {};
        return raw;
    }
    return global.discordMap || {};
}

async function setDiscordId(staff, discordId) {
    if (redis) {
        await redis.hSet(DISCORD_MAP_KEY, staff, discordId);
    } else {
        if (!global.discordMap) global.discordMap = {};
        global.discordMap[staff] = discordId;
    }
}

async function resolveMention(staffNick) {
    // Primero busca en el mapa de IDs guardados
    const map = await getDiscordMap();
    if (map[staffNick]) return `<@${map[staffNick]}>`;
    // Fallback: busca por nombre en el guild
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const members = await guild.members.fetch();
        const lower = staffNick.toLowerCase();
        const found = members.find(m =>
            m.user.username.toLowerCase()    === lower ||
            m.displayName.toLowerCase()      === lower ||
            (m.nickname && m.nickname.toLowerCase() === lower)
        );
        return found ? `<@${found.user.id}>` : `**${staffNick}**`;
    } catch {
        return `**${staffNick}**`;
    }
}

// ── Skin ───────────────────────────────────────────────────────────────────
function skinUrl(nick) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/128`;
}

// Obtiene el avatar de Discord del staff si tiene ID vinculada, sino omite el icon
async function getAuthorIcon(staffName) {
    try {
        const map = await getDiscordMap();
        const discordId = map[staffName];
        if (discordId) {
            const user = await Promise.race([
                client.users.fetch(discordId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            return user.displayAvatarURL({ size: 64 });
        }
    } catch { /* fallback */ }
    return skinUrl(staffName);
}

// ── DM al admin en caso de error ───────────────────────────────────────────
async function dmAdmin(msg) {
    if (!ADMIN_DISCORD_ID) return;
    try {
        const user = await client.users.fetch(ADMIN_DISCORD_ID);
        await user.send(`⚠️ **Error en StaffPanel:**\n\`\`\`\n${msg}\n\`\`\``);
    } catch(e) { console.error('dmAdmin:', e.message); }
}

// ── Historial de acciones por staff ───────────────────────────────────────
const STAFF_HIST_KEY = (staff) => `staffhist:${staff.toLowerCase()}`;

async function saveStaffHistorial(staff, tipo, nick, datos) {
    const key = STAFF_HIST_KEY(staff);
    const entry = { tipo, nick, datos, fecha: Date.now() };
    if (redis) {
        await redis.lPush(key, JSON.stringify(entry));
        await redis.lTrim(key, 0, 99);
    } else {
        if (!global.staffHist) global.staffHist = {};
        if (!global.staffHist[key]) global.staffHist[key] = [];
        global.staffHist[key].unshift(entry);
        if (global.staffHist[key].length > 100) global.staffHist[key].pop();
    }
}

async function getStaffHistorial(staff) {
    const key = STAFF_HIST_KEY(staff);
    if (redis) {
        const raw = await redis.lRange(key, 0, 49);
        return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    }
    return (global.staffHist || {})[key] || [];
}

// ── Historial de sanciones por jugador ────────────────────────────────────
const HIST_KEY = (nick) => `hist:${nick.toLowerCase()}`;

async function saveHistorial(nick, tipo, staff, datos) {
    const key = HIST_KEY(nick);
    const entry = { tipo, staff, datos, fecha: Date.now() };
    if (redis) {
        await redis.lPush(key, JSON.stringify(entry));
        await redis.lTrim(key, 0, 49); // máximo 50 entradas por jugador
    } else {
        if (!global.historial) global.historial = {};
        if (!global.historial[key]) global.historial[key] = [];
        global.historial[key].unshift(entry);
        if (global.historial[key].length > 50) global.historial[key].pop();
    }
}

async function getHistorial(nick) {
    const key = HIST_KEY(nick);
    if (redis) {
        const raw = await redis.lRange(key, 0, 49);
        return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    }
    return (global.historial || {})[key] || [];
}

// ── Enviar embed + imágenes ────────────────────────────────────────────────
async function send(channelId, embed, imagenes) {
    if (!channelId) return { error: 'Canal no configurado' };
    try {
        const ch = await client.channels.fetch(channelId);
        await ch.send({ embeds:[embed] });
        const files = (imagenes||[]).map((b,i)=>toAttachment(b,i)).filter(Boolean);
        if (files.length > 0) await ch.send({ files });
        return { ok: true };
    } catch(e) {
        console.error('send:', e.message);
        await dmAdmin(`send() falló en canal ${channelId}: ${e.message}`);
        return { error: e.message };
    }
}

// ── Embed builders con fields (más anchos y legibles) ─────────────────────

// ── Embed builders ────────────────────────────────────────────────────────

// ── Chequeo de antecedentes ────────────────────────────────────────────────
async function getAntecedentes(nick) {
    if (!nick) return null;
    const hist = await getHistorial(nick);
    const bans = hist.filter(e => e.tipo === 'ban' || e.tipo === 'ss-ban');
    if (!bans.length) return null;
    const total = bans.length;
    const ultimo = bans[0];
    const fecha = new Date(ultimo.fecha).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
    return total === 1
        ? `⚠️ 1 baneo previo (${fecha})`
        : `🔴 ${total} baneos previos — último el ${fecha}`;
}

async function embedSancion(staff, nick, modalidad, tiempo, razon, pruebas) {
    const icon = await getAuthorIcon(staff);
    const author = icon
        ? { name: `Ejecutado por ${staff}`, iconURL: icon }
        : { name: `Ejecutado por ${staff}` };
    const antecedentes = await getAntecedentes(nick);
    return new EmbedBuilder()
        .setColor(0xFF4444)
        .setAuthor(author)
        .setTitle('🚫 Nueva Sanción')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `⏱️ Tiempo: ${s(tiempo)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            (antecedentes ? `\n${antecedentes}\n` : '') +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

async function embedSS(staff, nick, modalidad, razon, pruebas, tiempo) {
    const icon = await getAuthorIcon(staff);
    const author = icon
        ? { name: `Ejecutado por ${staff}`, iconURL: icon }
        : { name: `Ejecutado por ${staff}` };
    const antecedentes = await getAntecedentes(nick);
    return new EmbedBuilder()
        .setColor(0x9B59B6)
        .setAuthor(author)
        .setTitle('🖥️ SS Ban')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n` +
            `⏱️ Tiempo: ${s(tiempo) || 'Permanente'}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            (antecedentes ? `\n${antecedentes}\n` : '') +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff • SS Ban' });
}

async function embedRB(staff, modalidad, nick, nick2, razon, tipo) {
    const icon = await getAuthorIcon(staff);
    const author = icon
        ? { name: `Ejecutado por ${staff}`, iconURL: icon }
        : { name: `Ejecutado por ${staff}` };
    return new EmbedBuilder()
        .setColor(tipo === 'online' ? 0x2ECC71 : 0xE74C3C)
        .setAuthor(author)
        .setTitle(`🔄 Rollback ${tipo==='online' ? '🟢 Online' : '🔴 Offline'}`)
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `👥 Nick involucrado: ${s(nick2)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `📋 Razón: ${s(razon)}\n` +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

async function embedMute(staff, nick, modalidad, tiempo, razon, pruebas) {
    const icon = await getAuthorIcon(staff);
    const author = icon
        ? { name: `Ejecutado por ${staff}`, iconURL: icon }
        : { name: `Ejecutado por ${staff}` };
    const antecedentes = await getAntecedentes(nick);
    return new EmbedBuilder()
        .setColor(0xF39C12)
        .setAuthor(author)
        .setTitle('🔇 Nuevo Mute')
        .setThumbnail(skinUrl(nick || staff))
        .setDescription(
            `\`\`\`yaml\n` +
            `👤 Nick: ${s(nick)}\n` +
            `📋 Razón: ${s(razon)}\n` +
            `⏱️ Tiempo: ${s(tiempo)}\n` +
            `🎮 Modalidad: ${s(modalidad)}\n\n` +
            `🔗 Pruebas: ${s(pruebas) || '—'}\n` +
            (antecedentes ? `\n${antecedentes}\n` : '') +
            `\`\`\``
        )
        .setTimestamp()
        .setFooter({ text: 'Tilted Staff' });
}

// ── Leaderboard ────────────────────────────────────────────────────────────
async function buildLBEmbed(data, cat, periodo) {
    const label    = periodo==='week' ? 'Semanal' : 'Mensual';
    const reset    = periodo==='week' ? 'Resetea cada domingo' : 'Resetea cada fin de mes';
    const catLabel = cat==='ss' ? 'SS Staff' : 'Staff';
    const color    = cat==='ss' ? 0x9B59B6 : (periodo==='week' ? 0xF39C12 : 0x5865F2);
    const entries  = Object.entries(data);

    if (!entries.length) return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🏆 Ranking ${catLabel} — ${label}`)
        .setDescription('```\nNo hay acciones registradas aún.\n```')
        .setFooter({ text: `Tilted Staff  •  ${reset}` });

    entries.sort((a,b) =>
        Object.values(b[1]).reduce((s,v)=>s+v,0) -
        Object.values(a[1]).reduce((s,v)=>s+v,0)
    );

    const medals = ['🥇','🥈','🥉'];
    const mentions = await Promise.all(entries.map(([staff]) => resolveMention(staff)));

    const lines = entries.map(([staff, stats], i) => {
        const total  = Object.values(stats).reduce((s,v)=>s+v,0);
        const medal  = medals[i] || `**#${i+1}**`;
        const mention = mentions[i];

        if (cat==='ss') {
            const ban    = stats['ss']       || 0;
            const appeal = stats['ss-appeal']|| 0;
            const clean  = stats['ss-clean'] || 0;
            const notes  = stats['ss-notes'] || 0;
            return (
                `${medal} ${mention} — **${total}** acciones\n` +
                `> 🚫 \`${ban}\` ban  •  📨 \`${appeal}\` appeal  •  ✅ \`${clean}\` clean  •  📝 \`${notes}\` notes`
            );
        }
        const bans  = stats.sanciones  || 0;
        const rbs   = stats.rollbacks  || 0;
        const mutes = stats.mutes      || 0;
        return (
            `${medal} ${mention} — **${total}** acciones\n` +
            `> 🚫 \`${bans}\` bans  •  🔄 \`${rbs}\` rollbacks  •  🔇 \`${mutes}\` mutes`
        );
    }).join('\n\n');

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🏆 Ranking ${catLabel} — ${label}`)
        .setDescription(lines)
        .setThumbnail(skinUrl(entries[0][0]))
        .setTimestamp()
        .setFooter({ text: `Tilted Staff  •  ${reset}` });
}

// ── Slash commands ─────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    if (['top-semanal','top-mensual','top-ss-semanal','top-ss-mensual'].includes(cmd)) {
        const periodo = cmd.includes('semanal') ? 'week' : 'month';
        const cat     = cmd.includes('ss') ? 'ss' : 'normal';
        const data    = await getLB(cat, periodo);
        await interaction.reply({ embeds: [await buildLBEmbed(data, cat, periodo)] });
    }

    if (cmd === 'vincular') {
        const usuario = interaction.options.getString('usuario');
        const discordId = interaction.user.id;
        await setDiscordId(usuario, discordId);
        await interaction.reply({
            content: `✅ Tu usuario **${usuario}** fue vinculado a ${interaction.user}. Aparecerás mencionado en el top.`,
            ephemeral: true
        });
    }

    if (cmd === 'historial') {
        await interaction.deferReply();
        const nick = interaction.options.getString('nick');
        const entries = await getHistorial(nick);
        if (!entries.length) {
            await interaction.editReply(`No hay registros para **${nick}**.`);
            return;
        }
        const tipos = { ban:'🚫 Ban', 'ss-ban':'🖥️ SS Ban', mute:'🔇 Mute', rollback:'🔄 Rollback', unban:'🔓 Unban' };
        const lines = entries.slice(0, 10).map(e => {
            const fecha = new Date(e.fecha).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
            const tipo  = tipos[e.tipo] || e.tipo;
            const razon = e.datos?.razon || '—';
            return `**${tipo}** — ${fecha} — por \`${e.staff}\`\n> ${razon}`;
        }).join('\n\n');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📋 Historial de ${nick}`)
            .setThumbnail(`https://minotar.net/avatar/${encodeURIComponent(nick)}/128`)
            .setDescription(lines)
            .setFooter({ text: `${entries.length} registro${entries.length !== 1 ? 's' : ''} total  •  Tilted Staff` })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }

    if (cmd === 'staff-info') {
        await interaction.deferReply();
        let usuario = interaction.options.getString('usuario');

        // Si pasaron un Discord ID o mención, resolver al username del panel
        const cleanId = usuario.replace(/[<@!>]/g, '');
        if (/^\d+$/.test(cleanId)) {
            // Es un Discord ID — buscar el username en el mapa inverso
            const map = await getDiscordMap();
            const found = Object.entries(map).find(([, id]) => id === cleanId);
            if (found) usuario = found[0];
        }

        const weekData  = await getLB('normal', 'week');
        const monthData = await getLB('normal', 'month');
        const ssWeek    = await getLB('ss', 'week');
        const ssMonth   = await getLB('ss', 'month');
        const wn = weekData[usuario]  || {};
        const mn = monthData[usuario] || {};
        const ws = ssWeek[usuario]    || {};
        const ms = ssMonth[usuario]   || {};
        const mention = await resolveMention(usuario);
        const map = await getDiscordMap();
        const discordId = map[usuario];
        let avatarUrl = null;
        if (discordId) {
            try {
                const u = await client.users.fetch(discordId);
                avatarUrl = u.displayAvatarURL({ size: 128 });
            } catch {}
        }

        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle(`📊 Stats de ${usuario}`)
            .setDescription(mention)
            .addFields(
                { name: '📅 Esta semana', value:
                    `🚫 \`${wn.sanciones||0}\` bans  •  🔄 \`${wn.rollbacks||0}\` rbs  •  🔇 \`${wn.mutes||0}\` mutes\n` +
                    `🖥️ \`${ws.ss||0}\` ss  •  📨 \`${ws['ss-appeal']||0}\` appeals  •  ✅ \`${ws['ss-clean']||0}\` cleans`,
                    inline: false },
                { name: '📆 Este mes', value:
                    `🚫 \`${mn.sanciones||0}\` bans  •  🔄 \`${mn.rollbacks||0}\` rbs  •  🔇 \`${mn.mutes||0}\` mutes\n` +
                    `🖥️ \`${ms.ss||0}\` ss  •  📨 \`${ms['ss-appeal']||0}\` appeals  •  ✅ \`${ms['ss-clean']||0}\` cleans`,
                    inline: false },
            )
            .setTimestamp()
            .setFooter({ text: 'Tilted Staff' });
        if (avatarUrl) embed.setThumbnail(avatarUrl);
        await interaction.editReply({ embeds: [embed] });
    }

    if (cmd === 'create-profile') {
        await interaction.deferReply({ ephemeral: true });
        // Verificar que quien ejecuta es admin del panel
        const callerDiscordId = interaction.user.id;
        const users = await getServerUsers();
        const caller = users.find(u => u.discordId === callerDiscordId);
        if (!caller || caller.role !== 'admin') {
            return await interaction.editReply('❌ Solo los admins del StaffPanel pueden usar este comando.');
        }
        const username   = interaction.options.getString('username');
        const password   = interaction.options.getString('password');
        const discordId  = interaction.options.getString('discord_id');
        const rol        = interaction.options.getString('rol') || 'staff';
        if (!['staff','admin'].includes(rol)) {
            return await interaction.editReply('❌ El rol debe ser `staff` o `admin`.');
        }
        if (users.find(u => u.username === username)) {
            return await interaction.editReply(`❌ Ya existe un usuario con el nombre **${username}**.`);
        }
        const hashed = await bcrypt.hash(password, SALT_ROUNDS);
        users.push({ username, password: hashed, role: rol, discordId });
        await saveServerUsers(users);
        if (discordId) await setDiscordId(username, discordId);
        await interaction.editReply(`✅ Perfil creado correctamente.\n\n👤 **Usuario:** ${username}\n🎭 **Rol:** ${rol}\n🔗 **Discord ID:** ${discordId}`);
        return;
    }

    if (cmd === 'sync-staff') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const members = await guild.members.fetch();
            const map = await getDiscordMap();
            let linked = 0;

            for (const [, member] of members) {
                const lower   = member.user.username.toLowerCase();
                const display = member.displayName.toLowerCase();
                const nick    = (member.nickname || '').toLowerCase();

                // Buscar si algún staff del mapa coincide con este miembro
                for (const staffName of Object.keys(map)) {
                    const sl = staffName.toLowerCase();
                    if (sl === lower || sl === display || sl === nick) {
                        const currentId = map[staffName];
                        if (currentId !== member.user.id) {
                            await setDiscordId(staffName, member.user.id);
                            linked++;
                        }
                    }
                }
            }

            await interaction.editReply(`✅ Sync completo. **${linked}** staff vinculados automáticamente.`);
        } catch(e) {
            console.error('sync-staff:', e.message);
            await interaction.editReply(`❌ Error: ${e.message}`);
        }
    }
});

// ── Discord OAuth2 callback ────────────────────────────────────────────────
app.post('/oauth/callback', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Falta code' });
    console.log(`[OAuth] Recibido code en ${new Date().toISOString()}`);
    try {
        const t1 = Date.now();
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id:     DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
                redirect_uri:  DISCORD_REDIRECT_URI,
            })
        });
        const tokenData = await tokenRes.json();
        console.log(`[OAuth] Token response en ${Date.now()-t1}ms:`, tokenData.error || 'OK');
        if (!tokenData.access_token) {
            console.log('[OAuth] Token data completo:', JSON.stringify(tokenData));
            return res.status(400).json({ error: 'Token inválido', detail: tokenData });
        }

        const t2 = Date.now();
        // Obtener info del usuario
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();
        console.log(`[OAuth] User fetch en ${Date.now()-t2}ms, id: ${user.id}, username: ${user.username}`);

        const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || 0) % 5}.png`;

        res.json({
            ok: true,
            discordId:   user.id,
            username:    user.username,
            displayName: user.global_name || user.username,
            avatar:      avatarUrl,
        });
    } catch(e) {
        console.error('oauth/callback:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── User management endpoints ──────────────────────────────────────────────
app.get('/users', auth, async (req, res) => {
    const users = await getServerUsers();
    // No mandar passwords al cliente
    res.json(users.map(u => ({ username: u.username, role: u.role, discordId: u.discordId || '' })));
});

app.post('/users', auth, async (req, res) => {
    const { username, password, role, discordId } = req.body;
    if (!username || !password) return res.json({ error: 'Faltan datos' });
    const users = await getServerUsers();
    if (users.find(u => u.username === username)) return res.json({ error: 'Usuario ya existe' });
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    users.push({ username, password: hashed, role: role || 'staff', discordId: discordId || '' });
    await saveServerUsers(users);
    if (discordId) await setDiscordId(username, discordId);
    res.json({ ok: true });
});

app.delete('/users', auth, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ error: 'Falta username' });
    let users = await getServerUsers();
    users = users.filter(u => u.username !== username);
    await saveServerUsers(users);
    res.json({ ok: true });
});

app.post('/users/update-discord', auth, async (req, res) => {
    const { username, discordId } = req.body;
    if (!username || !discordId) return res.json({ error: 'Faltan datos' });
    const users = await getServerUsers();
    const u = users.find(u => u.username === username);
    if (!u) return res.json({ error: 'Usuario no encontrado' });
    u.discordId = discordId;
    await saveServerUsers(users);
    await setDiscordId(username, discordId);
    res.json({ ok: true });
});

// ── Auth endpoints ─────────────────────────────────────────────────────────
const ACCESS_LOGS_KEY = 'sp:access_logs';

async function saveAccessLog(username, ip, method) {
    const entry = { username, ip, method, fecha: Date.now() };
    if (redis) {
        await redis.lPush(ACCESS_LOGS_KEY, JSON.stringify(entry));
        await redis.lTrim(ACCESS_LOGS_KEY, 0, 199); // máximo 200 entradas
    } else {
        if (!global.accessLogs) global.accessLogs = [];
        global.accessLogs.unshift(entry);
        if (global.accessLogs.length > 200) global.accessLogs.pop();
    }
}

async function getAccessLogs() {
    if (redis) {
        const raw = await redis.lRange(ACCESS_LOGS_KEY, 0, 99);
        return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    }
    return (global.accessLogs || []).slice(0, 100);
}

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
    if (!username || !password) return res.json({ error: 'Faltan datos' });
    const users = await getServerUsers();
    const found = users.find(u => u.username === username);
    if (!found) {
        await saveAccessLog(username, ip, 'failed');
        return res.json({ error: 'Usuario o contraseña incorrectos' });
    }
    const match = await bcrypt.compare(password, found.password).catch(() => false);
    if (!match) {
        await saveAccessLog(username, ip, 'failed');
        return res.json({ error: 'Usuario o contraseña incorrectos' });
    }
    await saveAccessLog(username, ip, 'login');
    res.json({ ok: true, user: { username: found.username, role: found.role, discordId: found.discordId || '' } });
});

// También loguear acceso por Discord
app.get('/auth/discord', async (req, res) => {
    const { discordId } = req.query;
    if (!discordId) return res.json({ error: 'Falta discordId' });
    const users = await getServerUsers();
    const found = users.find(u => u.discordId === discordId);
    if (!found) return res.json({ error: 'Discord ID no registrada' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
    await saveAccessLog(found.username, ip, 'discord');
    res.json({ ok: true, user: { username: found.username, role: found.role, discordId: found.discordId } });
});

// ── Endpoint para ver los logs (solo desde panel) ──────────────────────────
app.get('/access-logs', auth, async (req, res) => {
    const logs = await getAccessLogs();
    res.json({ ok: true, logs });
});

app.post('/users/change-password', auth, async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    if (!username || !oldPassword || !newPassword) return res.json({ error: 'Faltan datos' });
    const users = await getServerUsers();
    const u = users.find(u => u.username === username);
    if (!u) return res.json({ error: 'Usuario no encontrado' });
    const match = await bcrypt.compare(oldPassword, u.password).catch(() => false);
    if (!match) return res.json({ error: 'Contraseña actual incorrecta' });
    u.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await saveServerUsers(users);
    res.json({ ok: true });
});

// ── Top JSON endpoint para el panel ───────────────────────────────────────
app.get('/top', async (req, res) => {
    const cat     = req.query.cat    || 'normal';
    const periodo = req.query.periodo || 'week';
    const data    = await getLB(cat, periodo);
    const entries = Object.entries(data).sort((a,b) =>
        Object.values(b[1]).reduce((s,v)=>s+v,0) -
        Object.values(a[1]).reduce((s,v)=>s+v,0)
    );
    const map = await getDiscordMap();
    const result = await Promise.all(entries.slice(0,10).map(async ([staff, stats]) => {
        const discordId = map[staff];
        let avatar = null;
        if (discordId) {
            try {
                const user = await Promise.race([
                    client.users.fetch(discordId),
                    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
                ]);
                avatar = user.displayAvatarURL({ size: 64 });
            } catch {}
        }
        const total = Object.values(stats).reduce((s,v)=>s+v,0);
        return { staff, stats, total, avatar, discordId };
    }));
    res.json({ ok: true, data: result, cat, periodo });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'online', uptime: process.uptime() });
});
app.get('/', (req,res) => res.json({ status:'online', bot:client.user?.tag||'conectando...' }));

// ── Link Discord ID ────────────────────────────────────────────────────────
app.post('/link-discord', auth, async (req,res) => {
    const { staff, discordId } = req.body;
    if (!staff || !discordId) return res.json({ error: 'Faltan datos' });
    await setDiscordId(staff, discordId);
    res.json({ ok: true, message: `${staff} vinculado a <@${discordId}>` });
});

app.get('/discord-map', auth, async (req,res) => {
    const map = await getDiscordMap();
    res.json(map);
});

// ── Endpoints ──────────────────────────────────────────────────────────────
app.post('/sancion', auth, async (req,res) => {
    const { staff, modalidad, razon, tiempo, nick, pruebas, imagenes } = req.body;
    await addStat(staff, 'sanciones');
    await saveHistorial(nick, 'ban', staff, { modalidad, tiempo, razon, pruebas });
    await saveStaffHistorial(staff, 'ban', nick, { modalidad, tiempo, razon, pruebas });
    res.json(await send(CHANNEL_SANCIONES, await embedSancion(staff,nick,modalidad,tiempo,razon,pruebas), imagenes));
});

app.post('/ss', auth, async (req,res) => {
    const { staff, modalidad, razon, nick, pruebas, imagenes, tiempo } = req.body;
    await addStat(staff, 'ss');
    await saveHistorial(nick, 'ss-ban', staff, { modalidad, tiempo, razon, pruebas });
    await saveStaffHistorial(staff, 'ss-ban', nick, { modalidad, tiempo, razon, pruebas });
    if (!CHANNEL_SS) return res.json({ error: 'Canal no configurado' });
    try {
        const ch = await client.channels.fetch(CHANNEL_SS);
        const msg = await ch.send({ embeds: [await embedSS(staff,nick,modalidad,razon,pruebas,tiempo)] });
        const files = (imagenes||[]).map((b,i)=>toAttachment(b,i)).filter(Boolean);
        if (files.length > 0) await ch.send({ files });
        await msg.react('✅');
        await msg.react('❌');
        res.json({ ok: true });
    } catch(e) {
        console.error('ss:', e.message);
        await dmAdmin(`/ss falló: ${e.message}`);
        res.json({ error: e.message });
    }
});

// ── Historial por staff (para panel admin) ─────────────────────────────────
app.get('/staff-historial', auth, async (req, res) => {
    const { staff } = req.query;
    if (!staff) return res.json({ error: 'Falta staff' });
    const entries = await getStaffHistorial(staff);
    res.json({ ok: true, entries });
});

app.get('/staff-historial/all', auth, async (req, res) => {
    const users = await getServerUsers();
    const result = await Promise.all(
        users.map(async u => {
            const entries = await getStaffHistorial(u.username);
            return { staff: u.username, entries };
        })
    );
    res.json({ ok: true, data: result });
});

app.post('/rollback', auth, async (req,res) => {
    const { staff, modalidad, nick, nick2, razon, tipo, imagenes } = req.body;
    await addStat(staff, 'rollbacks');
    await saveHistorial(nick, 'rollback', staff, { modalidad, nick2, razon, tipo });
    await saveStaffHistorial(staff, 'rollback', nick, { modalidad, nick2, razon, tipo });
    res.json(await send(CHANNEL_ROLLBACKS, await embedRB(staff,modalidad,nick,nick2,razon,tipo), imagenes));
});

app.post('/mute', auth, async (req,res) => {
    const { staff, modalidad, nick, tiempo, razon, pruebas, imagenes } = req.body;
    await addStat(staff, 'mutes');
    await saveHistorial(nick, 'mute', staff, { modalidad, tiempo, razon, pruebas });
    await saveStaffHistorial(staff, 'mute', nick, { modalidad, tiempo, razon, pruebas });
    res.json(await send(CHANNEL_MUTES, await embedMute(staff,nick,modalidad,tiempo,razon,pruebas), imagenes));
});

app.post('/unbaneo', auth, async (req,res) => {
    const { staff, nick, razon, modalidad, imagenes } = req.body;
    const embed = new EmbedBuilder()
        .setColor(0x43B581)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('🔓 Unbaneo')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',      value: s(nick),      inline: true  },
            { name: '🎮 Modalidad', value: s(modalidad), inline: true  },
            { name: '📋 Razón',     value: s(razon),     inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff` });
    res.json(await send(CHANNEL_SANCIONES, embed, imagenes));
});

app.post('/ss-appeal', auth, async (req,res) => {
    const { staff, nick, razon, modalidad, pruebas, imagenes } = req.body;
    await addStat(staff, 'ss-appeal');
    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('📨 SS Appeal')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',       value: s(nick),       inline: true  },
            { name: '🎮 Modalidad',  value: s(modalidad),  inline: true  },
            { name: '📋 Razón',      value: s(razon),      inline: false },
            { name: '🔗 Pruebas',    value: s(pruebas) || '—', inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Appeal` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

app.post('/ss-clean', auth, async (req,res) => {
    const { staff, nick, imagenes } = req.body;
    await addStat(staff, 'ss-clean');
    const embed = new EmbedBuilder()
        .setColor(0x43B581)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('✅ SS Clean')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick', value: s(nick), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Clean` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

app.post('/ss-notes', auth, async (req,res) => {
    const { staff, nick, motivo, imagenes } = req.body;
    await addStat(staff, 'ss-notes');
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setAuthor({ name: `Ejecutado por ${staff}`, iconURL: skinUrl(staff) })
        .setTitle('📝 SS Notes')
        .setThumbnail(skinUrl(nick || staff))
        .addFields(
            { name: '👤 Nick',    value: s(nick),   inline: true  },
            { name: '📋 Motivo', value: s(motivo), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Tilted Staff • SS Notes` });
    res.json(await send(CHANNEL_SS, embed, imagenes));
});

// ── Vincular staff username → Discord ID ──────────────────────────────────
app.post('/vincular', auth, async (req,res) => {
    const { staff, discordId } = req.body;
    if (!staff || !discordId) return res.json({ error: 'Faltan datos' });
    await setDiscordId(staff, discordId);
    res.json({ ok: true, message: `${staff} vinculado a <@${discordId}>` });
});

app.get('/vincular', auth, async (req,res) => {
    const map = await getDiscordMap();
    res.json({ ok: true, map });
});

app.delete('/vincular', auth, async (req,res) => {
    const { staff } = req.body;
    if (!staff) return res.json({ error: 'Falta staff' });
    if (redis) { await redis.hDel(DISCORD_MAP_KEY, staff); }
    else { if (global.discordMap) delete global.discordMap[staff]; }
    res.json({ ok: true });
});

// ── Auto-vincular al entrar al servidor ───────────────────────────────────
async function tryAutoLink(member) {
    try {
        const map = await getDiscordMap();
        const lower = member.user.username.toLowerCase();
        const display = member.displayName.toLowerCase();
        const nick = (member.nickname || '').toLowerCase();

        // Buscar en el mapa si ya está vinculado
        const alreadyLinked = Object.values(map).includes(member.user.id);
        if (alreadyLinked) return;

        // Buscar coincidencia con algún staff registrado en el panel
        // El panel guarda usuarios en localStorage del cliente, pero el bot
        // puede intentar matchear por username/displayName/nickname
        const staffNames = Object.keys(map);
        // Si no hay staff en el mapa, no hay nada con qué comparar aún
        // El match se hace cuando algún staff ya fue registrado manualmente
        // y un nuevo miembro entra con el mismo nombre
        for (const staffName of staffNames) {
            if (
                staffName.toLowerCase() === lower ||
                staffName.toLowerCase() === display ||
                staffName.toLowerCase() === nick
            ) {
                await setDiscordId(staffName, member.user.id);
                console.log(`Auto-vinculado: ${staffName} → ${member.user.id}`);
                return;
            }
        }
    } catch(e) { console.error('tryAutoLink:', e.message); }
}

client.on('guildMemberAdd', async member => {
    await tryAutoLink(member);
});

// ── Registrar slash commands ───────────────────────────────────────────────
async function registerCommands() {
    if (!CLIENT_ID || !GUILD_ID) { console.log('Sin CLIENT_ID/GUILD_ID'); return; }
    const commands = [
        new SlashCommandBuilder().setName('top-semanal').setDescription('Ranking semanal del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-mensual').setDescription('Ranking mensual del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-semanal').setDescription('Ranking semanal de SS (bans, appeals, cleans, notes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-mensual').setDescription('Ranking mensual de SS (bans, appeals, cleans, notes)').toJSON(),
        new SlashCommandBuilder()
            .setName('historial')
            .setDescription('Muestra el historial de sanciones de un jugador')
            .addStringOption(o => o.setName('nick').setDescription('Nick del jugador de Minecraft').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('staff-info')
            .setDescription('Muestra las stats de un staff específico')
            .addStringOption(o => o.setName('usuario').setDescription('Usuario del StaffPanel').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('vincular')
            .setDescription('Vincula tu usuario del panel con tu Discord')
            .addStringOption(o => o.setName('usuario').setDescription('Tu usuario del StaffPanel').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('create-profile')
            .setDescription('Crea un perfil en el StaffPanel (solo admins)')
            .addStringOption(o => o.setName('username').setDescription('Nombre de usuario').setRequired(true))
            .addStringOption(o => o.setName('password').setDescription('Contraseña').setRequired(true))
            .addStringOption(o => o.setName('discord_id').setDescription('Discord ID del staff').setRequired(true))
            .addStringOption(o => o.setName('rol').setDescription('Rol: staff o admin (por defecto: staff)').setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('sync-staff')
            .setDescription('Sincroniza todos los miembros del servidor con el mapa de Discord IDs (usar 1 vez)')
            .toJSON(),
    ];
    const rest = new REST({ version:'10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Slash commands registrados');
    } catch(e) { console.error('Commands:', e.message); }
}

app.post('/register-commands', auth, async (req,res) => {
    if (!CLIENT_ID || !GUILD_ID) return res.json({ error: 'Falta CLIENT_ID o GUILD_ID en .env' });
    const commands = [
        new SlashCommandBuilder().setName('top-semanal').setDescription('Ranking semanal del staff').toJSON(),
        new SlashCommandBuilder().setName('top-mensual').setDescription('Ranking mensual del staff').toJSON(),
        new SlashCommandBuilder().setName('top-ss-semanal').setDescription('Ranking semanal de SS').toJSON(),
        new SlashCommandBuilder().setName('top-ss-mensual').setDescription('Ranking mensual de SS').toJSON(),
    ];
    const rest = new REST({ version:'10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        res.json({ ok: true, message: '4 slash commands registrados correctamente' });
    } catch(e) {
        console.error('register-commands:', e.message);
        res.json({ error: e.message });
    }
});

// ── Boot ───────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    client.user.setActivity('Tilted Staff', { type: ActivityType.Watching });
    await registerCommands();
});

connectRedis().then(() => {
    client.login(BOT_TOKEN).then(() => {
        app.listen(PORT, () => console.log(`API en puerto ${PORT}`));
    }).catch(err => { console.error('Login:', err.message); process.exit(1); });
});
