require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ActivityType, REST, Routes, SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
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

// ── Redis ──
let redis = null;
async function connectRedis() {
    if (!REDIS_URL) { console.log('⚠️  Sin Redis'); return; }
    redis = createClient({ url: REDIS_URL });
    redis.on('error', e => console.error('Redis:', e.message));
    await redis.connect();
    console.log('✅ Redis conectado');
}

// ── Periodo keys ──
function getWeekKey(tipo)  {
    const n = new Date(), jan = new Date(n.getFullYear(),0,1);
    const w = Math.ceil(((n-jan)/86400000+jan.getDay()+1)/7);
    return `lb:${tipo}:week:${n.getFullYear()}:${w}`;
}
function getMonthKey(tipo) {
    const n = new Date();
    return `lb:${tipo}:month:${n.getFullYear()}:${n.getMonth()+1}`;
}
function ttlWeek() {
    const n=new Date(),s=new Date(n);
    s.setDate(n.getDate()+(7-n.getDay())); s.setHours(23,59,59,0);
    return Math.max(1, Math.floor((s-n)/1000));
}
function ttlMonth() {
    const n=new Date(),l=new Date(n.getFullYear(),n.getMonth()+1,0,23,59,59);
    return Math.max(1, Math.floor((l-n)/1000));
}

// ── Sumar stat: tipo = 'sanciones'|'ss'|'rollbacks'|'mutes'|'ss-appeal'|'ss-clean'|'ss-notes' ──
async function addStat(staff, tipo) {
    if (!staff || !tipo) return;
    // Determinar si es stat normal o stat SS
    const isSSExtra = ['ss-appeal','ss-clean','ss-notes'].includes(tipo);
    const cat = isSSExtra ? 'ss' : 'normal'; // dos leaderboards
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

// ── Auth ──
function auth(req, res, next) {
    if (req.headers['x-api-key'] !== SECRET_KEY) return res.status(401).json({ error: 'No autorizado' });
    next();
}
function s(v) { return (!v||String(v).trim()==='') ? '—' : String(v).slice(0,1024); }

// ── Base64 → Attachment ──
function toAttachment(b64, i) {
    try {
        const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!m) return null;
        return new AttachmentBuilder(Buffer.from(m[2],'base64'), { name:`prueba_${i+1}.${m[1]}` });
    } catch(e) { return null; }
}

// ── Botones (solo para SS) ──
function makeSSButtons() {
    const uid = crypto.randomUUID().slice(0,8);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ok_${uid}`).setLabel('✅ Confirmar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`no_${uid}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger)
    );
}

// ── Enviar al canal ──
async function send(channelId, embed, formato, imagenes, withButtons=false) {
    if (!channelId) return { error: 'Canal no configurado' };
    try {
        const ch    = await client.channels.fetch(channelId);
        const files = (imagenes||[]).map((b,i)=>toAttachment(b,i)).filter(Boolean);
        // Mandar el formato de texto PRIMERO (arriba del embed)
        if (formato) await ch.send({ content: formato });
        // Solo SS lleva botones
        const components = withButtons ? [makeSSButtons()] : [];
        await ch.send({ embeds:[embed], components, files });
        return { ok: true };
    } catch(e) { console.error('send:', e.message); return { error: e.message }; }
}

// ── Embed builders ──
function embedSancion(staff,nick,modalidad,tiempo,razon) {
    return new EmbedBuilder().setColor(0xFF4444).setTitle('🚫 Nueva Sanción')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'⏱️ Tiempo',value:s(tiempo),inline:true},
            {name:'📋 Razón',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff'});
}
function embedSS(staff,nick,modalidad,razon) {
    return new EmbedBuilder().setColor(0x9B59B6).setTitle('🖥️ SS Ban')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'📋 Razón SS',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff • SS Ban'});
}
function embedRB(staff,modalidad,nick,nick2,razon,tipo) {
    return new EmbedBuilder().setColor(0x7289DA).setTitle(`🔄 Rollback ${tipo==='online'?'🟢 Online':'🔴 Offline'}`)
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'\u200B',value:'\u200B',inline:true},
            {name:'🎯 Nick afectado',value:s(nick),inline:true},
            {name:'🤝 Nick involucrado',value:s(nick2),inline:true},
            {name:'\u200B',value:'\u200B',inline:true},
            {name:'📋 Razón',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff'});
}
function embedMute(staff,nick,modalidad,tiempo,razon) {
    return new EmbedBuilder().setColor(0xF39C12).setTitle('🔇 Nuevo Mute')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'⏱️ Tiempo',value:s(tiempo),inline:true},
            {name:'📋 Razón',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff'});
}

// ── Leaderboard embed ──
function buildLBEmbed(data, cat, periodo) {
    const label = periodo==='week' ? '📅 Semanal' : '🗓️ Mensual';
    const reset = periodo==='week' ? 'Resetea cada domingo' : 'Resetea cada fin de mes';
    const catLabel = cat==='ss' ? '🖥️ SS Staff' : '⚔️ Staff';

    const entries = Object.entries(data);
    if (!entries.length) return new EmbedBuilder().setColor(0xF39C12)
        .setTitle(`🏆 ${catLabel} — ${label}`).setDescription('No hay acciones aún.').setFooter({text:reset});

    entries.sort((a,b)=>Object.values(b[1]).reduce((s,v)=>s+v,0)-Object.values(a[1]).reduce((s,v)=>s+v,0));
    const medals=['🥇','🥈','🥉'];

    const lines = entries.map(([staff,stats],i)=>{
        const total = Object.values(stats).reduce((s,v)=>s+v,0);
        const medal = medals[i]||`**${i+1}.**`;
        if (cat==='ss') {
            const ban    = stats['ss']||0;
            const appeal = stats['ss-appeal']||0;
            const clean  = stats['ss-clean']||0;
            const notes  = stats['ss-notes']||0;
            return `${medal} **${staff}** — ${total} total  *(🚫${ban} ban  📨${appeal} appeal  ✅${clean} clean  📝${notes} notes)*`;
        }
        return `${medal} **${staff}** — ${total} total  *(🚫${stats.sanciones||0}  🔄${stats.rollbacks||0}  🔇${stats.mutes||0})*`;
    }).join('\n');

    return new EmbedBuilder()
        .setColor(cat==='ss' ? 0x9B59B6 : (periodo==='week' ? 0xF39C12 : 0x7289DA))
        .setTitle(`🏆 ${catLabel} — ${label}`)
        .setDescription(lines)
        .setTimestamp()
        .setFooter({text:`Tilted Staff • ${reset}`});
}

// ── Interacciones ──
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (!interaction.customId.startsWith('ok_') && !interaction.customId.startsWith('no_')) return;
        const ok = interaction.customId.startsWith('ok_');
        try {
            const orig = interaction.message.embeds[0];
            if (!orig) return;
            // Ponemos ✅ o ❌ al inicio del título
            const oldTitle = orig.title || '';
            // Quitar cualquier ✅/❌ previo del título por si ya fue procesado
            const cleanTitle = oldTitle.replace(/^[✅❌]\s*/, '');
            const newTitle = ok ? `✅ ${cleanTitle}` : `❌ ${cleanTitle}`;
            await interaction.update({
                embeds: [
                    EmbedBuilder.from(orig)
                        .setTitle(newTitle)
                        .setColor(ok ? 0x43B581 : 0xFF0000)
                        .setFooter({ text: `${ok ? '✅ Confirmado' : '❌ Rechazado'} por ${interaction.user.username}` })
                ],
                components: []
            });
        } catch(e) { console.error('Button:', e.message); }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    if (['top-semanal','top-mensual','top-ss-semanal','top-ss-mensual'].includes(cmd)) {
        const periodo = cmd.includes('semanal') ? 'week' : 'month';
        const cat     = cmd.includes('ss') ? 'ss' : 'normal';
        const data    = await getLB(cat, periodo);
        await interaction.reply({ embeds:[buildLBEmbed(data, cat, periodo)] });
    }
});

// ── Health check ──
app.get('/', (req,res) => res.json({ status:'online', bot:client.user?.tag||'conectando...' }));

// ── Endpoints ──
app.post('/sancion', auth, async (req,res) => {
    const {staff,modalidad,razon,tiempo,nick,imagenes,formato}=req.body;
    await addStat(staff,'sanciones');
    res.json(await send(CHANNEL_SANCIONES, embedSancion(staff,nick,modalidad,tiempo,razon), formato, imagenes, false));
});
app.post('/ss', auth, async (req,res) => {
    const {staff,modalidad,razon,nick,imagenes,formato}=req.body;
    await addStat(staff,'ss');
    res.json(await send(CHANNEL_SS, embedSS(staff,nick,modalidad,razon), formato, imagenes, true));
});
app.post('/rollback', auth, async (req,res) => {
    const {staff,modalidad,nick,nick2,razon,tipo,imagenes,formato}=req.body;
    await addStat(staff,'rollbacks');
    res.json(await send(CHANNEL_ROLLBACKS, embedRB(staff,modalidad,nick,nick2,razon,tipo), formato, imagenes, false));
});
app.post('/mute', auth, async (req,res) => {
    const {staff,modalidad,nick,tiempo,razon,imagenes,formato}=req.body;
    await addStat(staff,'mutes');
    res.json(await send(CHANNEL_MUTES, embedMute(staff,nick,modalidad,tiempo,razon), formato, imagenes, false));
});
app.post('/unbaneo', auth, async (req,res) => {
    const {staff,nick,razon,modalidad,imagenes,formato}=req.body;
    const embed = new EmbedBuilder().setColor(0x43B581).setTitle('🔓 Unbaneo')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'📋 Razón',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff'});
    res.json(await send(CHANNEL_SANCIONES, embed, formato, imagenes, false));
});
app.post('/ss-appeal', auth, async (req,res) => {
    const {staff,nick,razon,modalidad,pruebas,imagenes,formato}=req.body;
    await addStat(staff,'ss-appeal');
    const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('📨 SS Appeal')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'🎮 Modalidad',value:s(modalidad),inline:true},
            {name:'📋 Razón',value:s(razon),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff • SS Appeal'});
    res.json(await send(CHANNEL_SS, embed, formato, imagenes, true));
});
app.post('/ss-clean', auth, async (req,res) => {
    const {staff,nick,imagenes,formato}=req.body;
    await addStat(staff,'ss-clean');
    const embed = new EmbedBuilder().setColor(0x43B581).setTitle('✅ SS Clean')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true}
        ).setTimestamp().setFooter({text:'Tilted Staff • SS Clean'});
    res.json(await send(CHANNEL_SS, embed, formato, imagenes, true));
});
app.post('/ss-notes', auth, async (req,res) => {
    const {staff,nick,motivo,imagenes,formato}=req.body;
    await addStat(staff,'ss-notes');
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('📝 SS Notes')
        .addFields(
            {name:'👤 Staff',value:s(staff),inline:true},
            {name:'🎯 Nick',value:s(nick),inline:true},
            {name:'📋 Motivo',value:s(motivo),inline:false}
        ).setTimestamp().setFooter({text:'Tilted Staff • SS Notes'});
    res.json(await send(CHANNEL_SS, embed, formato, imagenes, true));
});

// ── Registrar slash commands ──
async function registerCommands() {
    if (!CLIENT_ID || !GUILD_ID) { console.log('⚠️  Sin CLIENT_ID/GUILD_ID'); return; }
    const commands = [
        new SlashCommandBuilder().setName('top-semanal').setDescription('🏆 Ranking semanal del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-mensual').setDescription('🏆 Ranking mensual del staff (sanciones, rollbacks, mutes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-semanal').setDescription('🖥️ Ranking semanal de SS (bans, appeals, cleans, notes)').toJSON(),
        new SlashCommandBuilder().setName('top-ss-mensual').setDescription('🖥️ Ranking mensual de SS (bans, appeals, cleans, notes)').toJSON(),
    ];
    const rest = new REST({ version:'10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('✅ 4 slash commands registrados');
    } catch(e) { console.error('Commands:', e.message); }
}

client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    client.user.setActivity('Tilted Staff', { type: ActivityType.Watching });
    await registerCommands();
});

connectRedis().then(() => {
    client.login(BOT_TOKEN).then(() => {
        app.listen(PORT, () => console.log(`🌐 API en puerto ${PORT}`));
    }).catch(err => { console.error('Login:', err.message); process.exit(1); });
});
