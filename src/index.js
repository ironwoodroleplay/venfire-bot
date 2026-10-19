import {moderationNames,handleModeration} from './moderation.js';
import {handleTicketInteraction,postTicketPanel} from './tickets.js';
import {Client,GatewayIntentBits,Events,ButtonBuilder,ButtonStyle,ActionRowBuilder,Partials,ActivityType,AuditLogEvent,EmbedBuilder} from 'discord.js';
import {db,GUILD_ID,DISCORD_TOKEN,settings,audit,logTo,canManage,instructor,hasAllowedRole} from './common.js';
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildMessageReactions,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel,Partials.Reaction,Partials.User]});
const dateOnly=d=>new Date(d).toISOString().slice(0,10);
const reply=(i,s)=>i.editReply({content:String(s).slice(0,1900),allowedMentions:{parse:[]}});
async function finishGiveaway(row,reroll=false){const g=await client.guilds.fetch(GUILD_ID);const entries=await db.query('SELECT member_id FROM giveaway_entries WHERE giveaway_id=$1',[row.id]);const ids=entries.rows.map(x=>x.member_id);for(let i=ids.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}const winners=ids.slice(0,row.winner_count);if(!reroll)await db.query('UPDATE giveaways SET ended=TRUE,winners=$2 WHERE id=$1',[row.id,JSON.stringify(winners)]);else await db.query('UPDATE giveaways SET winners=$2 WHERE id=$1',[row.id,JSON.stringify(winners)]);const ch=await g.channels.fetch(row.channel_id).catch(()=>null);if(ch?.isTextBased())await ch.send({content:`Giveaway #${row.id} ${reroll?'rerolled':'ended'}: **${row.prize}**\nWinners: ${winners.length?winners.map(id=>`<@${id}>`).join(', '):'No entries'}`,allowedMentions:{users:winners}});await audit(null,reroll?'giveaway.reroll':'giveaway.end',{id:row.id,winners});await eventLog(g,'giveaway',reroll?'Giveaway rerolled':'Giveaway ended',`#${row.id}: ${row.prize} | Winners: ${winners.join(', ')||'None'}`);return winners;}
async function tick(){try{const r=await db.query('SELECT * FROM giveaways WHERE guild_id=$1 AND ended=FALSE AND ends_at<=NOW() ORDER BY id LIMIT 20',[GUILD_ID]);for(const row of r.rows)await finishGiveaway(row);}catch(e){console.error('Giveaway scheduler',e);}}
// Save a durable, point-in-time quota report before moving the current cycle forward.
// Includes members with zero activity; excludes bot accounts.
async function archiveQuotaCycle(cx, s, zone, endedAt) {
 const guild=await client.guilds.fetch(GUILD_ID);
 const members=await guild.members.fetch();
 const ids=[...members.values()].filter(m=>!m.user.bot).map(m=>m.id);
 const prior=await cx.query('SELECT started_at FROM quota_cycles WHERE guild_id=$1 FOR UPDATE',[GUILD_ID]);
 const start=prior.rows[0]?.started_at || new Date(endedAt.getTime()-(s.quotaPeriod==='monthly'?31:7)*86400000);
 const startAt=new Date(start);
 if(startAt>=endedAt)throw Error('Quota cycle start must precede its end');
 const targetMinutes=Math.max(0,Number(s.quotaMinutes)||0);
 const targetTrainings=Math.max(0,Number(s.quotaTrainings)||0);
 const period=await cx.query(`INSERT INTO quota_history_periods(guild_id,started_at,ended_at,timezone,target_minutes,target_trainings,member_count)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(guild_id,ended_at) DO UPDATE SET member_count=EXCLUDED.member_count RETURNING id`,
 [GUILD_ID,startAt,endedAt,zone,targetMinutes,targetTrainings,ids.length]);
 const periodId=period.rows[0].id;
 const totals=await cx.query(`WITH sh AS (
 SELECT member_id, GREATEST(0,ROUND(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at,$3::timestamptz),$3::timestamptz)-GREATEST(started_at,$2::timestamptz)))/60)))::int AS minutes
 FROM shifts WHERE guild_id=$1 AND started_at<$3 AND COALESCE(ended_at,$3::timestamptz)>$2 GROUP BY member_id
 ), tr AS (SELECT member_id,COUNT(*)::int trainings FROM training_logs WHERE guild_id=$1 AND result='pass' AND created_at >=$2 AND created_at<$3 GROUP BY member_id)
 SELECT COALESCE(sh.member_id,tr.member_id) member_id,COALESCE(sh.minutes,0) minutes,COALESCE(tr.trainings,0) trainings FROM sh FULL JOIN tr ON sh.member_id=tr.member_id`,
 [GUILD_ID,startAt,endedAt]);
 const byMember=new Map(totals.rows.map(r=>[r.member_id,r]));
 for(const id of ids){const r=byMember.get(id);const minutes=r?.minutes||0,trainings=r?.trainings||0;
  await cx.query(`INSERT INTO quota_history_members(period_id,member_id,shift_minutes,passed_trainings,passed)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(period_id,member_id) DO UPDATE SET shift_minutes=EXCLUDED.shift_minutes,passed_trainings=EXCLUDED.passed_trainings,passed=EXCLUDED.passed`,
   [periodId,id,minutes,trainings,minutes>=targetMinutes&&trainings>=targetTrainings]);
 }
 return {periodId,memberCount:ids.length};
}
// Shared, database-backed quota leaderboard for slash commands and scheduled reminders.
async function quotaLeaderboard(s, limit=15){
 const period=s.quotaPeriod==='monthly'?'month':'week';
 const targetMin=Math.max(0,Number(s.quotaMinutes)||0),targetTrain=Math.max(0,Number(s.quotaTrainings)||0);
 const sql=`WITH start_time AS (
 SELECT GREATEST(date_trunc($2,NOW()),COALESCE((SELECT started_at FROM quota_cycles WHERE guild_id=$1),'-infinity'::timestamptz)) AS start_at),
 time_totals AS (SELECT member_id,GREATEST(0,COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,NOW())-GREATEST(started_at,(SELECT start_at FROM start_time))))/60)),0))::int AS minutes FROM shifts WHERE guild_id=$1 AND COALESCE(ended_at,NOW())>(SELECT start_at FROM start_time) GROUP BY member_id),
 training_totals AS (SELECT member_id,COUNT(*)::int AS trainings FROM training_logs WHERE guild_id=$1 AND result='pass' AND created_at>=(SELECT start_at FROM start_time) GROUP BY member_id)
 SELECT COALESCE(t.member_id,tr.member_id) AS member_id,COALESCE(t.minutes,0) AS minutes,COALESCE(tr.trainings,0) AS trainings FROM time_totals t FULL JOIN training_totals tr ON t.member_id=tr.member_id ORDER BY minutes DESC,trainings DESC LIMIT $3`;
 const r=await db.query(sql,[GUILD_ID,period,limit]);
 const lines=r.rows.map((x,j)=>`${j+1}. <@${x.member_id}> — ${x.minutes}/${targetMin} min | ${x.trainings}/${targetTrain} trainings | ${x.minutes>=targetMin&&x.trainings>=targetTrain?'PASS':'IN PROGRESS'}`);
 return {title:`Quota Leaderboard (${period==='week'?'Weekly':'Monthly'})`,description:(lines.join('\n')||'No quota activity yet.').slice(0,4096),count:r.rowCount};
}
// Persisted idempotency keys prevent duplicate sends/resets after restarts.
async function quotaScheduler(){
 try{
  const s=await settings();const zone=s.quotaTimezone||'America/Chicago';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const get=k=>parts.find(x=>x.type===k)?.value;
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'));
  const hour=Number(get('hour'));const date=`${get('year')}-${get('month')}-${get('day')}`;
  const jobs=[['reset',s.quotaResetEnabled,Number(s.quotaResetDay??0),Number(s.quotaResetHour??0)],['reminder',s.quotaReminderEnabled,Number(s.quotaReminderDay??6),Number(s.quotaReminderHour??12)]];
  for(const [kind,enabled,targetDay,targetHour] of jobs){
   if(!enabled||day!==targetDay||hour!==targetHour)continue;
   const key=`${kind}:${date}:${hour}`;
   if(kind==='reset'){
    const cx=await db.connect();try{await cx.query('BEGIN');const claimed=await cx.query('INSERT INTO quota_schedule_runs(guild_id,job_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_key',[GUILD_ID,key]);if(claimed.rowCount){const endedAt=new Date();const archived=await archiveQuotaCycle(cx,s,zone,endedAt);await cx.query('INSERT INTO quota_cycles(guild_id,started_at) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET started_at=EXCLUDED.started_at',[GUILD_ID,endedAt]);await cx.query('INSERT INTO audit_logs(guild_id,actor_id,action,detail) VALUES($1,NULL,$2,$3)',[GUILD_ID,'quota.reset',JSON.stringify({key,timezone:zone,...archived})]);}await cx.query('COMMIT');}catch(e){await cx.query('ROLLBACK');throw e;}finally{cx.release();}
   }else{
    if(!s.quotaReminderChannel)continue;
    const claimed=await db.query('INSERT INTO quota_schedule_runs(guild_id,job_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_key',[GUILD_ID,key]);if(!claimed.rowCount)continue;
    try{const guild=await client.guilds.fetch(GUILD_ID);const channel=await guild.channels.fetch(s.quotaReminderChannel);if(!channel?.isTextBased())throw Error('Reminder channel is not text based');const role=/^\d{17,20}$/.test(s.quotaReminderRole||'')?s.quotaReminderRole:null;const content=String(s.quotaReminderMessage||'Quota is due tomorrow! {role}').replaceAll('{role}',role?`<@&${role}>`:'').replaceAll('{nextDay}','tomorrow');const board=await quotaLeaderboard(s);await channel.send({content,embeds:[new EmbedBuilder().setTitle(board.title).setDescription(board.description).setColor(0x5865F2).setTimestamp()],allowedMentions:{parse:[],roles:role?[role]:[]}});await audit(null,'quota.reminder',{key});}
    catch(e){await db.query('DELETE FROM quota_schedule_runs WHERE guild_id=$1 AND job_key=$2',[GUILD_ID,key]);throw e;}
   }
  }
 }catch(e){console.error('Quota scheduler',e);}
}
// Synchronize the configurable LOA role against approved leave dates.
// The role is never removed while another approved LOA is active.
async function syncLoaRoles(){
 const config=await settings();
 const roleId=String(config.loaRoleId||'').trim();
 if(!/^\d{17,20}$/.test(roleId))return;
 const guild=await client.guilds.fetch(GUILD_ID);
 const role=await guild.roles.fetch(roleId).catch(()=>null);
 if(!role){console.error('[LOA roles] Configured role not found:',roleId);return;}
 const rows=await db.query(`SELECT member_id,BOOL_OR(status='approved' AND start_date<=CURRENT_DATE AND end_date>=CURRENT_DATE) AS active
 FROM loa_requests WHERE guild_id=$1 AND status IN ('approved','ended') GROUP BY member_id`,[GUILD_ID]);
 const active=new Set(rows.rows.filter(x=>x.active).map(x=>x.member_id));
 // Include holders of the role even if they no longer have an active request.
 const members=await guild.members.fetch();
 for(const member of members.values()){
  if(member.user.bot)continue;
  const shouldHave=active.has(member.id);
  const hasRole=member.roles.cache.has(roleId);
  if(shouldHave===hasRole)continue;
  try{
   if(shouldHave)await member.roles.add(roleId,'Approved active LOA');
   else await member.roles.remove(roleId,'LOA ended or expired');
   console.log(`[LOA roles] ${shouldHave?'Assigned':'Removed'} ${roleId} for ${member.id}`);
  }catch(e){console.error(`[LOA roles] Could not update ${member.id}:`,e);}
 }
}
let loaSyncRunning=false;
async function safeSyncLoaRoles(){if(loaSyncRunning)return;loaSyncRunning=true;try{await syncLoaRoles();}catch(e){console.error('[LOA roles] Sync failed',e);}finally{loaSyncRunning=false;}}
// Reaction roles: explicit diagnostics, uncached-message support, and DB-backed mappings.
function reactionKey(emoji){return String(emoji.id || emoji.name || '');}
async function applyReactionRole(reaction,user,adding){
 const action=adding?'add':'remove';
 try{
  console.log(`[Reaction roles] ${action} event received: message=${reaction.message?.id || 'unknown'} user=${user?.id || 'unknown'} partial=${reaction.partial}`);
  if(!user?.id || user.bot)return;
  if(reaction.partial)reaction=await reaction.fetch();
  const message=reaction.message;
  if(message.partial)await message.fetch();
  const guildId=message.guildId || message.guild?.id;
  if(guildId!==GUILD_ID){console.log(`[Reaction roles] Ignored reaction from guild ${guildId}`);return;}
  const key=reactionKey(reaction.emoji);
  if(!key){console.warn('[Reaction roles] Reaction has no usable emoji key');return;}
  const rows=await db.query('SELECT role_id FROM reaction_roles WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3 AND emoji_key=$4',[GUILD_ID,message.channelId,message.id,key]);
  if(!rows.rowCount){console.log(`[Reaction roles] No mapping: channel=${message.channelId} message=${message.id} emoji=${key}`);return;}
  const guild=message.guild || await client.guilds.fetch(GUILD_ID);
  const member=await guild.members.fetch(user.id);
  for(const row of rows.rows){
   const role=await guild.roles.fetch(row.role_id);
   if(!role){console.error(`[Reaction roles] Role ${row.role_id} not found`);continue;}
   if(adding)await member.roles.add(role, 'VenFire reaction role');
   else await member.roles.remove(role, 'VenFire reaction role');
   console.log(`[Reaction roles] ${action} succeeded: user=${user.id} role=${role.id} message=${message.id}`);await eventLog(guild,'reaction',adding?'Reaction role assigned':'Reaction role removed',`Member: <@${user.id}>\nRole: <@&${role.id}>\nMessage: ${message.id}`);
  }
 }catch(e){console.error(`[Reaction roles] ${action} failed`,e);}
}
client.on(Events.MessageReactionAdd,(reaction,user)=>{void applyReactionRole(reaction,user,true);});
client.on(Events.MessageReactionRemove,(reaction,user)=>{void applyReactionRole(reaction,user,false);});

// Configurable logging categories. Settings live in the existing JSONB settings row.
const LOG_TYPES=['member','message','voice','role','channel','moderation','shift','training','loa','giveaway','reaction','application'];
const LOG_COLORS={member:0x4f9cf9,message:0x7986cb,voice:0x26a69a,role:0xab47bc,channel:0x42a5f5,moderation:0xef5350,shift:0x66bb6a,training:0xffca28,loa:0xffa726,giveaway:0xec407a,reaction:0x7e57c2,application:0x78909c};
function clipped(value,limit=900){return String(value??'Unknown').slice(0,limit).replace(/`/g,'\u02cb');}
async function eventLog(guild,category,title,description,fields=[]){
 if(!guild||guild.id!==GUILD_ID)return;
 try{
  const cfg=await settings(),opts=cfg.logging||{};
  if(opts[category]?.enabled===false)return;
  const channelId=opts[category]?.channel||cfg[({member:'memberLogChannel',role:'roleLogChannel',shift:'shiftLogChannel',training:'trainingLogChannel',loa:'loaLogChannel'})[category]]||opts.fallbackChannel;
  if(!channelId)return;
  const channel=await guild.channels.fetch(channelId).catch(()=>null);
  if(!channel?.isTextBased()||typeof channel.send!=='function')return;
  const raw=String(opts[category]?.color||'').replace('#','');
  const color=/^[a-fA-F0-9]{6}$/.test(raw)?parseInt(raw,16):LOG_COLORS[category]||0x5865f2;
  const embed=new EmbedBuilder().setColor(color).setTitle(clipped(title,256)).setDescription(clipped(description,3900)).setTimestamp().setFooter({text:`VenFire • ${category} logs`});
  if(fields.length)embed.addFields(fields.slice(0,20).map(f=>({name:clipped(f.name,256),value:clipped(f.value,1000)||'—',inline:!!f.inline})));
  await channel.send({embeds:[embed],allowedMentions:{parse:[]}});
 }catch(e){console.error(`[Logging] ${category}:`,e);}
}
async function auditActor(guild,type,targetId){
 try{const logs=await guild.fetchAuditLogs({type,limit:5});const item=logs.entries.find(x=>String(x.target?.id)===String(targetId)&&Date.now()-x.createdTimestamp<12000);return item?.executor?.id||null;}catch{return null;}
}
client.on(Events.MessageDelete,m=>{void (async()=>{if(!m.guild)return;await eventLog(m.guild,'message','Message deleted',`Channel: <#${m.channelId}>\nAuthor: ${m.author?`<@${m.author.id}>`:'Unknown (uncached message)'}\nMessage ID: ${m.id}`,[{name:'Content (if cached)',value:clipped(m.content||'Unavailable',1000)}]);})();});
client.on(Events.MessageUpdate,(a,b)=>{if(!b.guild||a.content===b.content||a.content===undefined||b.content===undefined)return;void eventLog(b.guild,'message','Message edited',`Channel: <#${b.channelId}>\nAuthor: ${b.author?`<@${b.author.id}>`:'Unknown'}\nMessage ID: ${b.id}`,[{name:'Before',value:clipped(a.content||'(empty)',1000)},{name:'After',value:clipped(b.content||'(empty)',1000)}]);});
client.on(Events.MessageBulkDelete,(messages,channel)=>{if(channel.guild)void eventLog(channel.guild,'message','Messages bulk deleted',`${messages.size} messages removed in <#${channel.id}>`);});
client.on(Events.VoiceStateUpdate,(a,b)=>{if(a.channelId===b.channelId)return;const title=!a.channelId?'Voice joined':!b.channelId?'Voice left':'Voice moved';void eventLog(b.guild,'voice',title,`Member: <@${b.id}>\nFrom: ${a.channelId?`<#${a.channelId}>`:'None'}\nTo: ${b.channelId?`<#${b.channelId}>`:'None'}`);});
client.on(Events.GuildRoleCreate,r=>{void eventLog(r.guild,'role','Role created',`Role: <@&${r.id}>\nID: ${r.id}`);});
client.on(Events.GuildRoleDelete,r=>{void eventLog(r.guild,'role','Role deleted',`Name: ${clipped(r.name)}\nID: ${r.id}`);});
client.on(Events.GuildRoleUpdate,(a,b)=>{const changes=[];for(const key of ['name','color','hoist','mentionable','permissions'])if(String(a[key])!==String(b[key]))changes.push(key);if(changes.length)void eventLog(b.guild,'role','Role updated',`Role: <@&${b.id}>\nChanged: ${changes.join(', ')}`);});
client.on(Events.ChannelCreate,ch=>{if(ch.guild)void eventLog(ch.guild,'channel','Channel created',`Channel: <#${ch.id}>\nID: ${ch.id}`);});
client.on(Events.ChannelDelete,ch=>{if(ch.guild)void eventLog(ch.guild,'channel','Channel deleted',`Name: ${clipped(ch.name)}\nID: ${ch.id}`);});
client.on(Events.ChannelUpdate,(a,b)=>{if(!b.guild)return;const changes=[];for(const key of ['name','topic','nsfw','parentId','rateLimitPerUser'])if(a[key]!==b[key])changes.push(key);if(changes.length)void eventLog(b.guild,'channel','Channel updated',`Channel: <#${b.id}>\nChanged: ${changes.join(', ')}`);});
client.on(Events.GuildBanAdd,ban=>{void (async()=>{const actor=await auditActor(ban.guild,AuditLogEvent.MemberBanAdd,ban.user.id);await eventLog(ban.guild,'moderation','Member banned',`Member: <@${ban.user.id}> (${ban.user.id})\nModerator: ${actor?`<@${actor}>`:'Unavailable'}`);})();});
client.on(Events.GuildBanRemove,ban=>{void (async()=>{const actor=await auditActor(ban.guild,AuditLogEvent.MemberBanRemove,ban.user.id);await eventLog(ban.guild,'moderation','Member unbanned',`Member: <@${ban.user.id}> (${ban.user.id})\nModerator: ${actor?`<@${actor}>`:'Unavailable'}`);})();});
client.on(Events.GuildMemberUpdate,(a,b)=>{if(a.communicationDisabledUntilTimestamp!==b.communicationDisabledUntilTimestamp)void eventLog(b.guild,'moderation','Timeout changed',`Member: <@${b.id}>\nUntil: ${b.communicationDisabledUntilTimestamp?`<t:${Math.floor(b.communicationDisabledUntilTimestamp/1000)}:F>`:'Removed'}`);if(a.nickname!==b.nickname)void eventLog(b.guild,'moderation','Nickname changed',`Member: <@${b.id}>\nBefore: ${clipped(a.nickname||a.user.username)}\nAfter: ${clipped(b.nickname||b.user.username)}`);const added=b.roles.cache.filter(r=>!a.roles.cache.has(r.id));const removed=a.roles.cache.filter(r=>!b.roles.cache.has(r.id));if(added.size||removed.size)void eventLog(b.guild,'role','Member roles updated',`Member: <@${b.id}>\nAdded: ${added.map(r=>r.name).join(', ')||'None'}\nRemoved: ${removed.map(r=>r.name).join(', ')||'None'}`);});
client.on(Events.GuildMemberRemove,m=>{void (async()=>{const actor=await auditActor(m.guild,AuditLogEvent.MemberKick,m.id);if(actor)await eventLog(m.guild,'moderation','Member kicked',`Member: <@${m.id}>\nModerator: <@${actor}>`);})();});
// Bot presence rotates independently of the dashboard. The member count is always shown.
let presenceIndex=0;
let lastPresenceConfig=null;
let presenceConfigFetchedAt=0;
let humanMemberCount=null;
let humanMemberCountFetchedAt=0;
async function getHumanMemberCount(guild){
 if(humanMemberCount===null||Date.now()-humanMemberCountFetchedAt>=60000){
  // Fetch the full member list, not just cached users.
  const members=await guild.members.fetch();
  humanMemberCount=members.filter(member=>!member.user.bot).size;
  humanMemberCountFetchedAt=Date.now();
 }
 return humanMemberCount;
}
async function updateBotPresence(){
 try {
  if(!client.user)return;
  const guild=client.guilds.cache.get(GUILD_ID)||await client.guilds.fetch(GUILD_ID);
  if(!guild)return;
  if(!lastPresenceConfig||Date.now()-presenceConfigFetchedAt>=15000){
   lastPresenceConfig=await settings();presenceConfigFetchedAt=Date.now();
  }
  const cfg=lastPresenceConfig;
  const count=await getHumanMemberCount(guild);
  const statuses=[`${count.toLocaleString('en-US')} members`, ...[cfg.botStatusOne,cfg.botStatusTwo].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim().slice(0,128))];
  const activity=statuses[presenceIndex%statuses.length];
  presenceIndex=(presenceIndex+1)%statuses.length;
  await client.user.setPresence({status:'online',activities:[{name:activity,type:ActivityType.Watching}]});
 }catch(error){console.error('[Bot status] Update failed:',error);}
}
async function presenceLoop(){
 await updateBotPresence();
 const seconds=Math.min(10,Math.max(5,Math.round(Number(lastPresenceConfig?.botStatusInterval)||7)));
 setTimeout(presenceLoop,seconds*1000);
}
client.once(Events.ClientReady,async()=>{
 console.log('VenFire Utilities online as',client.user.tag);
 void presenceLoop();
 console.log('[Reaction roles] GuildMessageReactions intent and message/channel/reaction partials enabled');
 try{const count=await db.query('SELECT COUNT(*)::int AS count FROM reaction_roles WHERE guild_id=$1',[GUILD_ID]);console.log(`[Reaction roles] ${count.rows[0].count} mappings loaded from database`);}catch(e){console.error('[Reaction roles] Database check failed',e);}
 await tick();await quotaScheduler();void safeSyncLoaRoles();setInterval(tick,30000);setInterval(quotaScheduler,60000);setInterval(safeSyncLoaRoles,60000);
});
client.on(Events.GuildMemberAdd,async m=>{if(m.guild.id!==GUILD_ID)return;const s=await settings();if(s.welcomeChannel){let message=(s.welcomeMessage||"**<:VenFire:1561176811583578122> Welcome to Venmont Fire & Emergency Services, {user}!**\n\n> We're now at {memberCount} members.\n\n**Our Offices:**\n\n- <:VenFire_OFP:1561176759549042779> Fire Protection\n- <:VenFire_OMS:1561303676197535754> Medical Services\n- <:VenFire_OFM:1561302758685016105> State Fire Marshal\n\n**Apply:** <#1527205925843374110>\n\n> Verify with **<@426537812993638400>** inside of <#1547460043199479808>\n\n**Glad you joined!** — *VenFire High Command*").replaceAll('{user}',`<@${m.id}>`).replaceAll('{server}',m.guild.name).replaceAll('{memberCount}',String(m.guild.memberCount));await logTo(m.guild,{welcomeChannel:s.welcomeChannel},'welcomeChannel',message);}await eventLog(m.guild,'member','Member joined',`<@${m.id}> (${m.id})`);});
client.on(Events.GuildMemberRemove,async m=>{if(m.guild.id!==GUILD_ID)return;await eventLog(m.guild,'member','Member left',`${m.user?.tag||m.id} (${m.id})`);});
client.on(Events.GuildMemberUpdate,async(a,b)=>{if(b.guild.id!==GUILD_ID)return;const s=await settings();const before=a.roles.cache.map(r=>r.id),after=b.roles.cache.map(r=>r.id);const added=after.filter(x=>!before.includes(x)),removed=before.filter(x=>!after.includes(x));});
client.on(Events.InteractionCreate,async i=>{if(i.guildId!==GUILD_ID)return;try{
if(await handleTicketInteraction(i))return;
if(i.isButton()&&i.customId.startsWith('loa-review:')){
 const [,action,idString]=i.customId.split(':');
 if(!['approve','deny'].includes(action)||!/^\d+$/.test(idString))return i.reply({content:'Invalid LOA action.',ephemeral:true});
 const s=await settings();
 if(!(canManage(i)||hasAllowedRole(i,s.loaReviewerRoles)))return i.reply({content:'You are not permitted to review LOAs.',ephemeral:true});
 await i.deferReply({ephemeral:true});
 const status=action==='approve'?'approved':'denied';
 const result=await db.query("UPDATE loa_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3 AND guild_id=$4 AND status='pending' RETURNING *",[status,i.user.id,idString,GUILD_ID]);
 if(!result.rowCount)return i.editReply('This request has already been reviewed or does not exist.');
 const row=result.rows[0];
 const updated=new EmbedBuilder().setColor(status==='approved'?0x2ecc71:0xe74c3c).setTitle(`LOA #${row.id} — ${status.toUpperCase()}`).setDescription(`Applicant: <@${row.member_id}>\nDates: ${dateOnly(row.start_date)} to ${dateOnly(row.end_date)}\nReason: ${String(row.reason).slice(0,1500)}\nReviewed by: <@${i.user.id}>`).setTimestamp();
 await i.message.edit({embeds:[updated],components:[],allowedMentions:{parse:[]}}).catch(e=>console.error('LOA message update failed',e));
 await audit(i.user.id,'loa.review',{id:row.id,status,member:row.member_id});
 await safeSyncLoaRoles();
 await eventLog(i.guild,'loa','LOA reviewed',`LOA #${row.id}: ${status} for <@${row.member_id}> by <@${i.user.id}>`);
 await i.guild.members.fetch(row.member_id).then(m=>m.send(`Your VenFire LOA #${row.id} has been **${status}**.`)).catch(()=>{});
 return i.editReply(`LOA #${row.id} ${status}.`);
}
if(i.isButton()&&i.customId.startsWith('giveaway:')){const id=Number(i.customId.split(':')[1]);const r=await db.query('SELECT id FROM giveaways WHERE id=$1 AND guild_id=$2 AND ended=FALSE AND ends_at>NOW()',[id,GUILD_ID]);if(!r.rowCount)return i.reply({content:'This giveaway has ended.',ephemeral:true});await db.query('INSERT INTO giveaway_entries(giveaway_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,i.user.id]);return i.reply({content:'You entered the giveaway.',ephemeral:true});}
if(!i.isChatInputCommand())return;const cmd=i.commandName,sub=i.options.getSubcommand(false);await i.deferReply({ephemeral:!(cmd==='quota'&&sub==='leaderboard')});const s=await settings();
if(moderationNames.has(cmd))return reply(i,await handleModeration(i));
if(cmd==='training-log'){
 if(!instructor(i,s))return reply(i,'You are not authorized to log training.');
 const member=i.options.getUser('member',true),roblox=i.options.getString('roblox_username',true),score=i.options.getString('score',true),result=i.options.getString('result',true),office=i.options.getString('office',true);
 const officeRoles={ofp:s.trainingOfficeOfpRoles,oms:s.trainingOfficeOmsRoles,ofm:s.trainingOfficeOfmRoles};
 if(!Object.hasOwn(officeRoles,office))return reply(i,'Invalid office.');
 const r=await db.query('INSERT INTO training_logs(guild_id,member_id,instructor_id,roblox_username,score,result,office) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[GUILD_ID,member.id,i.user.id,roblox,score,result,office]);
 const actions=[];const target=await i.guild.members.fetch(member.id).catch(()=>null);
 const add=result==='pass'?[...(s.passAddRoles||[]),...(officeRoles[office]||[])]:s.failAddRoles||[];
 const remove=result==='pass'?s.passRemoveRoles||[]:s.failRemoveRoles||[];
 if(!target)actions.push('Member is not in server');else{
  for(const id of new Set(add)){try{await target.roles.add(id,`Training ${result} (${office}) by ${i.user.id}`);actions.push(`Added ${id}`);}catch(e){actions.push(`FAILED add ${id}: ${e.message}`);}}
  for(const id of new Set(remove)){try{await target.roles.remove(id,`Training ${result} (${office}) by ${i.user.id}`);actions.push(`Removed ${id}`);}catch(e){actions.push(`FAILED remove ${id}: ${e.message}`);}}
 }
 await db.query('UPDATE training_logs SET role_actions=$1 WHERE id=$2',[JSON.stringify(actions),r.rows[0].id]);
 await audit(i.user.id,'training.create',{member:member.id,result,score,office,actions});
 await eventLog(i.guild,'training','Training activity',`Training #${r.rows[0].id} | Office: ${office.toUpperCase()} | Discord: ${member.tag} | Roblox: ${roblox} | Score: ${score} | ${result.toUpperCase()} | Instructor: ${i.user.tag} | Roles: ${actions.join('; ')||'none'}`);
 return reply(i,`Training #${r.rows[0].id} recorded for ${office.toUpperCase()} (${result}). Role actions: ${actions.join('; ')||'none'}`);
}
if(cmd==='shift'){
 const fmtDuration=(minutes)=>{const total=Math.max(0,Math.floor(Number(minutes)||0));const hours=Math.floor(total/60),mins=total%60;return hours?`${hours} hour${hours===1?'':'s'}${mins?` ${mins} minute${mins===1?'':'s'}`:''}`:`${mins} minute${mins===1?'':'s'}`;};
 const discordTime=(date)=>{const ms=new Date(date).getTime();return Number.isFinite(ms)?`<t:${Math.floor(ms/1000)}:F> (<t:${Math.floor(ms/1000)}:R>)`:'Unknown time';};
 if(sub==='start'){
  const r=await db.query('INSERT INTO shifts(guild_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,started_at',[GUILD_ID,i.user.id]).catch(e=>{if(e.code==='23505')return {rowCount:0};throw e;});
  if(!r.rowCount)return reply(i,'You already have an active shift.');
  const started=discordTime(r.rows[0].started_at);
  await audit(i.user.id,'shift.start');
  await eventLog(i.guild,'shift','Shift activity',`Shift started: ${i.user.tag} | ${started}`);
  return reply(i,`**Shift started**\nStarted: ${started}`);
 }
 if(sub==='end'){
  const r=await db.query('UPDATE shifts SET ended_at=NOW() WHERE guild_id=$1 AND member_id=$2 AND ended_at IS NULL RETURNING started_at,ended_at,EXTRACT(EPOCH FROM (ended_at-started_at))/60 AS minutes',[GUILD_ID,i.user.id]);
  if(!r.rowCount)return reply(i,'No active shift.');
  const duration=fmtDuration(r.rows[0].minutes);
  await audit(i.user.id,'shift.end',{minutes:r.rows[0].minutes});
  await eventLog(i.guild,'shift','Shift activity',`Shift ended: ${i.user.tag} | Duration: ${duration} | Ended: ${discordTime(r.rows[0].ended_at)}`);
  return reply(i,`**Shift ended**\nStarted: ${discordTime(r.rows[0].started_at)}\nEnded: ${discordTime(r.rows[0].ended_at)}\n**Total duration:** ${duration}`);
 }
 const r=await db.query('SELECT started_at,EXTRACT(EPOCH FROM (NOW()-started_at))/60 AS minutes FROM shifts WHERE guild_id=$1 AND member_id=$2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',[GUILD_ID,i.user.id]);
 if(!r.rowCount)return reply(i,'No active shift.');
 return reply(i,`**Shift active**\nStarted: ${discordTime(r.rows[0].started_at)}\n**Current duration:** ${fmtDuration(r.rows[0].minutes)}`);
}
if(cmd==='quota'){
 if(sub==='leaderboard'){
  const board=await quotaLeaderboard(s);
  return i.editReply({embeds:[new EmbedBuilder().setTitle(board.title).setDescription(board.description).setColor(0x5865F2).setTimestamp()],allowedMentions:{parse:[]}});
 }
 const period=s.quotaPeriod==='monthly'?'month':'week';
 const id=i.options.getUser('member')?.id||i.user.id;
 const base=`WITH start_time AS (SELECT GREATEST(date_trunc($2,NOW()),COALESCE((SELECT started_at FROM quota_cycles WHERE guild_id=$1),'-infinity'::timestamptz)) AS start_at),
 time_totals AS (SELECT member_id,GREATEST(0,COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,NOW())-GREATEST(started_at,(SELECT start_at FROM start_time))))/60)),0))::int AS minutes FROM shifts WHERE guild_id=$1 AND COALESCE(ended_at,NOW())>(SELECT start_at FROM start_time) GROUP BY member_id),
 training_totals AS (SELECT member_id,COUNT(*)::int AS trainings FROM training_logs WHERE guild_id=$1 AND result='pass' AND created_at>=(SELECT start_at FROM start_time) GROUP BY member_id)
 SELECT COALESCE(t.member_id,tr.member_id) AS member_id,COALESCE(t.minutes,0) AS minutes,COALESCE(tr.trainings,0) AS trainings FROM time_totals t FULL JOIN training_totals tr ON t.member_id=tr.member_id`;
 const r=await db.query(`SELECT * FROM (${base}) totals WHERE member_id=$3`,[GUILD_ID,period,id]);
 const row=r.rows[0]||{minutes:0,trainings:0};
 return reply(i,`<@${id}>: ${row.minutes}/${Number(s.quotaMinutes||0)} shift minutes; ${row.trainings}/${Number(s.quotaTrainings||0)} passed trainings.`);
}
if(cmd==='loa'){
 if(sub==='request'){
  if(!hasAllowedRole(i,s.loaRequestRoles))return reply(i,'Your roles are not permitted to request LOAs.');
  const start=i.options.getString('start'),end=i.options.getString('end'),reason=i.options.getString('reason');
  const valid=x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
  if(!valid(start)||!valid(end)||end<start)return reply(i,'Dates must be valid YYYY-MM-DD, with end on or after start.');
  const r=await db.query('INSERT INTO loa_requests(guild_id,member_id,start_date,end_date,reason) VALUES($1,$2,$3,$4,$5) RETURNING id',[GUILD_ID,i.user.id,start,end,reason]);
  const id=r.rows[0].id;
  await audit(i.user.id,'loa.request',{id});
  const opts=s.logging||{};
  const channelId=opts.loa?.channel||s.loaLogChannel||opts.fallbackChannel;
  if(channelId){
   try{
    const channel=await i.guild.channels.fetch(channelId);
    if(channel?.isTextBased()){
     const embed=new EmbedBuilder().setColor(0xffa726).setTitle(`LOA #${id} — PENDING`).setDescription(`Applicant: <@${i.user.id}>\nDates: ${start} to ${end}\nReason: ${reason.slice(0,1500)}`).setTimestamp();
     const buttons=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`loa-review:approve:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`loa-review:deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger));
     await channel.send({embeds:[embed],components:[buttons],allowedMentions:{parse:[]}});
    }
   }catch(e){console.error('LOA review message failed',e);return reply(i,`LOA #${id} saved, but the review message could not be posted. Contact an administrator.`);}
  }else return reply(i,`LOA #${id} saved, but no LOA log channel is configured. Ask an administrator to set one.`);
  return reply(i,`LOA request #${id} submitted for review.`);
 }
 if(sub==='end'){
  const r=await db.query("UPDATE loa_requests SET status='ended',end_date=CURRENT_DATE WHERE id=(SELECT id FROM loa_requests WHERE guild_id=$1 AND member_id=$2 AND status='approved' AND start_date<=CURRENT_DATE AND end_date>=CURRENT_DATE ORDER BY end_date DESC,id DESC LIMIT 1) AND guild_id=$1 AND member_id=$2 RETURNING id,end_date",[GUILD_ID,i.user.id]);
  if(!r.rowCount)return reply(i,'You do not have an active approved LOA to end.');
  await safeSyncLoaRoles();
  await audit(i.user.id,'loa.end',{id:r.rows[0].id});
  await eventLog(i.guild,'loa','LOA ended early',`LOA #${r.rows[0].id} ended early by <@${i.user.id}>.`);
  return reply(i,`Your LOA #${r.rows[0].id} has been ended early.`);
 }
 const r=await db.query('SELECT id,start_date,end_date,status FROM loa_requests WHERE guild_id=$1 AND member_id=$2 ORDER BY id DESC LIMIT 10',[GUILD_ID,i.user.id]);
 return reply(i,r.rows.map(x=>`#${x.id}: ${x.status} (${dateOnly(x.start_date)} to ${dateOnly(x.end_date)})`).join('\n')||'No requests.');
}
if(cmd==='giveaway'){if(!hasAllowedRole(i,s.giveawayManagerRoles))return reply(i,'Your roles are not permitted to manage giveaways.');if(sub==='create'){const prize=i.options.getString('prize'),minutes=i.options.getInteger('minutes'),winners=i.options.getInteger('winners');const r=await db.query("INSERT INTO giveaways(guild_id,channel_id,prize,winner_count,ends_at,created_by) VALUES($1,$2,$3,$4,NOW()+($5 * INTERVAL '1 minute'),$6) RETURNING id,ends_at",[GUILD_ID,i.channelId,prize,winners,minutes,i.user.id]);const id=r.rows[0].id;const ping=(s.giveawayPingRole&&/^\d{17,20}$/.test(s.giveawayPingRole))?s.giveawayPingRole:null;const msg=await i.channel.send({content:`${ping?`<@&${ping}>\n`:''}Giveaway #${id}: **${prize}**\nEnds: <t:${Math.floor(r.rows[0].ends_at.getTime()/1000)}:R> | Winners: ${winners}`,allowedMentions:{roles:ping?[ping]:[]},components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway:${id}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Primary))]});await db.query('UPDATE giveaways SET message_id=$1 WHERE id=$2',[msg.id,id]);await audit(i.user.id,'giveaway.create',{id});await eventLog(i.guild,'giveaway','Giveaway created',`#${id}: ${prize} | Created by <@${i.user.id}>`);return reply(i,`Giveaway #${id} created.`);}const id=i.options.getInteger('id');const r=await db.query('SELECT * FROM giveaways WHERE id=$1 AND guild_id=$2',[id,GUILD_ID]);if(!r.rowCount)return reply(i,'Giveaway not found.');if(sub==='end'&&r.rows[0].ended)return reply(i,'Already ended.');if(sub==='reroll'&&!r.rows[0].ended)return reply(i,'End the giveaway first.');await finishGiveaway(r.rows[0],sub==='reroll');return reply(i,`Giveaway #${id} ${sub==='reroll'?'rerolled':'ended'}.`);}
}catch(e){console.error('Interaction error',e);if(i.deferred||i.replied)await reply(i,`Operation failed: ${e.message}`);else await i.reply({content:'Operation failed.',ephemeral:true}).catch(()=>{});}});
await client.login(DISCORD_TOKEN);

// Process dashboard panel publication requests (dashboard and bot share PostgreSQL).
async function ticketPanelQueue(){try{const r=await db.query("SELECT id FROM ticket_panel_jobs WHERE guild_id=$1 AND status='pending' ORDER BY id LIMIT 5",[GUILD_ID]);for(const job of r.rows){const claimed=await db.query("UPDATE ticket_panel_jobs SET status='processing' WHERE id=$1 AND status='pending' RETURNING id",[job.id]);if(!claimed.rowCount)continue;try{const guild=await client.guilds.fetch(GUILD_ID);const message=await postTicketPanel(guild);await db.query("UPDATE ticket_panel_jobs SET status='done',result=$2 WHERE id=$1",[job.id,message.url]);}catch(e){console.error('[Ticket panel]',e);await db.query("UPDATE ticket_panel_jobs SET status='error',result=$2 WHERE id=$1",[job.id,String(e.message).slice(0,500)]);}}}catch(e){console.error('[Ticket panel queue]',e);}}
setInterval(()=>void ticketPanelQueue(),15000);
