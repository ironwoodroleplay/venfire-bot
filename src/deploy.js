import {REST,Routes} from 'discord.js';import {commands} from './commands.js';import {DISCORD_TOKEN,DISCORD_CLIENT_ID,GUILD_ID} from './common.js';
const rest=new REST({version:'10'}).setToken(DISCORD_TOKEN);await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID,GUILD_ID),{body:commands});console.log('Registered',commands.length,'guild commands');process.exit(0);
