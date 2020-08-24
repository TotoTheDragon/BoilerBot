import { Message, MessageEmbed } from "discord.js";
import { WrappedClient } from "../client";
import { footer, footerurl } from "../config";
import { Event } from "../objects/Event";
import { WrappedMessage } from "../objects/WrappedMessage";
import { IGuildSettings } from "../database/schemas/Guild";
import { getErrorEmbed, getNoPermissionEmbed } from "../util/EmbedUtil";
import { settings } from "cluster";
import { getUserLevel } from "../util/OtherUtil";
import { CommandInfo } from "../objects/commands/CommandInfo";

export class CommandHandler implements Event {
    event = "message";
    type = "on";
    listener = async (client: WrappedClient, message: Message) => {

        if (message.author.bot) return;

        let wrappedMessage: WrappedMessage = message as WrappedMessage;

        let guildSettings: IGuildSettings = (await client.getSettings(message.guild?.id)).settings; // Get settings for the guild

        wrappedMessage.settings = guildSettings;
        const cmdInfo: CommandInfo = new CommandInfo(wrappedMessage);

        if (!(message.content.startsWith(guildSettings.prefix) || (message.mentions.users.find(u => u.id == client.user.id)))) return; // Ignore messages that do not have prefix
        let sliceLength = message.content.startsWith(guildSettings.prefix) ? guildSettings.prefix.length : client.user.id.length + 4; // Get amount of characters before command

        const args: string[] = message.content.slice(sliceLength).trim().split(" ");
        const command: string = args.shift();

        if (client.commands.has(command) || client.aliases.has(command)) { // Check if command exists
            let cmd = (client.commands.get(command) || client.aliases.get(command)); // Get command

            if (cmdInfo.isDM && !cmd.allowInDM) return; // Check if the command is executed in DMs and check if that is allowed

            if ((guildSettings.cmdLevels.get(cmd.label) ? guildSettings.cmdLevels.get(cmd.label) : cmd.defaultLevel) > getUserLevel(cmdInfo)) {
                return (await message.channel.send(
                    getNoPermissionEmbed()
                        .setTitle("Could not execute command")
                        .setDescription(`You do not have enough permissions to execute this command`)
                        .getAsEmbed()
                )).delete({ timeout: 5000 });
            }

            const argmap: Map<string, any> = new Map();

            if (cmd.arguments) {
                let str = args.join(" ");
                for (let i = 0; i < cmd.arguments.length; i++) {
                    const current = cmd.arguments[i];
                    const val = current.parse(str.trimStart());
                    argmap.set(current.identifier, val);
                    if (val) str = current.slice(str.trimStart());
                    if (current.required && !val) {
                        return (await message.channel.send(
                            getErrorEmbed()
                                .setTitle("Could not execute command")
                                .setDescription(`Missing argument **${current.name}**`)
                                .getAsEmbed()
                        )).delete({ timeout: 5000 });
                    }

                }
            }
            cmd.run(client, cmdInfo, args, argmap);
        }
    };

}
