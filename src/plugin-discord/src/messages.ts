import { composeContext, composeRandomUser, generateText } from "@elizaos/core";
import { generateMessageResponse, generateShouldRespond } from "@elizaos/core";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IBrowserService,
    ISpeechService,
    IVideoService,
    Media,
    Memory,
    ModelClass,
    ServiceType,
    State,
    UUID,
} from "@elizaos/core";
import { stringToUuid, getEmbeddingZeroVector } from "@elizaos/core";
import { generateMemeActionHandler } from "./actions/generate-meme.ts";
import {
    ChannelType,
    Client,
    Collection,
    Message as DiscordMessage,
    Message,
    TextChannel,
} from "discord.js";
import { elizaLogger } from "@elizaos/core";
import {
    discordShouldRespondTemplate,
    discordMessageHandlerTemplate,
} from "./templates.ts";
import {
    IGNORE_RESPONSE_WORDS,
    LOSE_INTEREST_WORDS,
    MESSAGE_CONSTANTS,
    MESSAGE_LENGTH_THRESHOLDS,
    RESPONSE_CHANCES,
    TEAM_COORDINATION,
    TIMING_CONSTANTS,
} from "./constants.ts";
import {
    sendMessageInChunks,
    canSendMessage,
    cosineSimilarity,
    generateUniqueVerificationCode,
    verifySignature,
    encryptMessage,
    decryptMessage,
} from "./utils.ts";

interface MessageContext {
    content: string;
    timestamp: number;
}

export type InterestChannels = {
    [key: string]: {
        currentHandler: string | undefined;
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
        previousContext?: MessageContext;
        contextSimilarityThreshold?: number;
    };
};

export class MessageManager {
    private client: Client;
    private runtime: IAgentRuntime;
    private interestChannels: InterestChannels = {};
    private discordClient: any;
    private SCHEDULED_MESSAGE_CONSTANTS: {
        MIN_MESSAGES_FOR_CONTEXT: number;
        TOPIC_RELEVANCE_THRESHOLD: number;
        MAX_RECENT_MESSAGES: number;
        HOUR_IN_MS: number;
    };

    constructor(discordClient: any) {
        this.client = discordClient.client;
        this.discordClient = discordClient;
        this.runtime = discordClient.runtime;
        this.SCHEDULED_MESSAGE_CONSTANTS = {
            HOUR_IN_MS: 60 * 60 * 1000,  // 1 hour in milliseconds
            MIN_MESSAGES_FOR_CONTEXT: 3,
            TOPIC_RELEVANCE_THRESHOLD: 0.6,
            MAX_RECENT_MESSAGES: 10
        };

        // Set interval to run every hour
        // setInterval(() => {
        //     this.sendScheduledMessage();
        // }, this.SCHEDULED_MESSAGE_CONSTANTS.HOUR_IN_MS);
    }

    async handleMessage(message: DiscordMessage) {
        if (
            message.interaction ||
            message.author.id ===
            this.client.user?.id /* || message.author?.bot*/
        ) {
            return;
        }

        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldIgnoreBotMessages &&
            message.author?.bot
        ) {
            return;
        }

        const userId = message.author.id as UUID;
        const userName = message.author.username;
        const name = message.author.displayName;
        const channelId = message.channel.id;
        const channelName = 'name' in message.channel ? message.channel.name : 'DM';
        
        // Check if this is a ticket channel - ticket channels have special behavior
        const isTicketChannel = channelName.toLowerCase().includes('ticket');
        
        // Only respond in the configured channel or in ticket channels
        if (channelId !== this.discordClient.channelId && !isTicketChannel) {
            return;
        }

        // Check for mentions-only mode setting (ticket channels are exempt from this restriction)
        if (
            !isTicketChannel &&
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            if (!this._isMessageForMe(message)) {
                return;
            }
        }

        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldIgnoreDirectMessages &&
            message.channel.type === ChannelType.DM
        ) {
            return;
        }
        const isDirectlyMentioned = this._isMessageForMe(message);
        const hasInterest = this._checkInterest(message.channelId);

        // In ticket channels, check if a core team member has already responded
        // Core team members are identified by having "Core Team" in their server nickname
        let coreTeamHasResponded = false;
        if (isTicketChannel && 'messages' in message.channel) {
            try {
                // Fetch recent messages to see if core team has responded
                const recentMessages = await (message.channel as TextChannel).messages.fetch({ limit: 20 });
                coreTeamHasResponded = recentMessages.some(msg => {
                    if (msg.author.bot) return false; // Ignore bot messages
                    
                    // Check server nickname (this is where "Core Team" appears in Discord)
                    const nickname = msg.member?.nickname?.toLowerCase() || '';
                    
                    // Also check username and global name as fallback
                    const username = msg.author.username?.toLowerCase() || '';
                    const globalName = msg.author.globalName?.toLowerCase() || '';
                    
                    return nickname.includes('core team') || 
                           username.includes('core team') || 
                           globalName.includes('core team');
                });
                
                if (coreTeamHasResponded && !isDirectlyMentioned) {
                    console.log(`Core team member has responded in ticket ${channelName}, bot backing off`);
                    return; // Don't respond if core team has taken over, unless directly mentioned
                }
            } catch (error) {
                console.error("Error checking for core team responses:", error);
                // Continue if there's an error checking messages
            }
        }

        // Team handling
        if (
            this.runtime.character.clientConfig?.discord?.isPartOfTeam &&
            !this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            const authorId = this._getNormalizedUserId(message.author.id);

            if (
                !this._isTeamLeader() &&
                this._isRelevantToTeamMember(message.content, channelId)
            ) {
                this.interestChannels[message.channelId] = {
                    currentHandler: this.client.user?.id,
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            }

            const isTeamRequest = this._isTeamCoordinationRequest(
                message.content
            );
            const isLeader = this._isTeamLeader();

            // After team-wide responses, check if we should maintain interest
            if (hasInterest && !isDirectlyMentioned) {
                const lastSelfMemories =
                    await this.runtime.messageManager.getMemories({
                        roomId: stringToUuid(
                            channelId + "-" + this.runtime.agentId
                        ),
                        unique: false,
                        count: 5,
                    });

                const lastSelfSortedMemories = lastSelfMemories
                    ?.filter((m) => m.userId === this.runtime.agentId)
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                const isRelevant = this._isRelevantToTeamMember(
                    message.content,
                    channelId,
                    lastSelfSortedMemories?.[0]
                );

                if (!isRelevant) {
                    // Clearing interest - conversation not relevant to team member
                    delete this.interestChannels[message.channelId];
                    return;
                }
            }

            if (isTeamRequest) {
                if (isLeader) {
                    this.interestChannels[message.channelId] = {
                        currentHandler: this.client.user?.id,
                        lastMessageSent: Date.now(),
                        messages: [],
                    };
                } else {
                    // Set temporary interest for this response
                    this.interestChannels[message.channelId] = {
                        currentHandler: this.client.user?.id,
                        lastMessageSent: Date.now(),
                        messages: [],
                    };

                    // Clear interest after this cycle unless directly mentioned
                    if (!isDirectlyMentioned) {
                        // Use existing message cycle to clear interest
                        this.interestChannels[
                            message.channelId
                        ].lastMessageSent = 0;
                    }
                }
            }

            // Check for other team member mentions
            const otherTeamMembers =
                this.runtime.character.clientConfig.discord.teamAgentIds.filter(
                    (id) => id !== this.client.user?.id
                );
            const mentionedTeamMember = otherTeamMembers.find((id) =>
                message.content.includes(`<@${id}>`)
            );

            // If another team member is mentioned, clear our interest
            if (mentionedTeamMember) {
                if (
                    hasInterest ||
                    this.interestChannels[message.channelId]?.currentHandler ===
                    this.client.user?.id
                ) {
                    delete this.interestChannels[message.channelId];

                    // Only return if we're not the mentioned member
                    if (!isDirectlyMentioned) {
                        return;
                    }
                }
            }

            // Set/maintain interest only if we're mentioned or already have interest
            if (isDirectlyMentioned) {
                this.interestChannels[message.channelId] = {
                    currentHandler: this.client.user?.id,
                    lastMessageSent: Date.now(),
                    messages: [],
                };
            } else if (!isTeamRequest && !hasInterest) {
                return;
            }

            // Bot-specific checks
            if (message.author.bot) {
                if (this._isTeamMember(authorId) && !isDirectlyMentioned) {
                    return;
                } else if (
                    this.runtime.character.clientConfig.discord
                        .shouldIgnoreBotMessages
                ) {
                    return;
                }
            }
        }

        try {
            const { processedContent, attachments } =
                await this.processMessageMedia(message);

            const audioAttachments = message.attachments.filter((attachment) =>
                attachment.contentType?.startsWith("audio/")
            );
            // if (audioAttachments.size > 0) {
            //     const processedAudioAttachments =
            //         await this.attachmentManager.processAttachments(
            //             audioAttachments
            //         );
            //     attachments.push(...processedAudioAttachments);
            // }

            const roomId = stringToUuid(channelId + "-" + this.runtime.agentId);
            const userIdUUID = stringToUuid(userId);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                userName,
                name,
                "discord"
            );

            const messageId = stringToUuid(
                message.id + "-" + this.runtime.agentId
            );

            let shouldIgnore = false;
            let shouldRespond = true;

            const content: Content = {
                text: processedContent,
                attachments: attachments,
                source: "discord",
                url: message.url,
                inReplyTo: message.reference?.messageId
                    ? stringToUuid(
                        message.reference.messageId +
                        "-" +
                        this.runtime.agentId
                    )
                    : undefined,
            };
            if (content.text.includes('!decrypt')) {
                const match = content.text.match(/!decrypt\s+"([^"]+)"/i);
                const text = match?.[1]?.trim();
                if (text) {
                    const decrypted = decryptMessage(text, process.env.DOCS_PK);
                    elizaLogger.info('decrypted text:', decrypted);
                    if (decrypted?.length) {
                        content.text = decrypted;
                    } else {
                        elizaLogger.warn('Decryption result was empty or invalid.');
                    }
                }
            }

            const userMessage = {
                content,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
            };

            const memory: Memory = {
                id: stringToUuid(message.id + "-" + this.runtime.agentId),
                ...userMessage,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
                content,
                createdAt: message.createdTimestamp,
            };

            if (content.text) {
                await this.runtime.messageManager.addEmbeddingToMemory(memory);
                await this.runtime.messageManager.createMemory(memory);

                if (this.interestChannels[message.channelId]) {
                    // Add new message
                    this.interestChannels[message.channelId].messages.push({
                        userId: userIdUUID,
                        userName: userName,
                        content: content,
                    });

                    // Trim to keep only recent messages
                    if (
                        this.interestChannels[message.channelId].messages
                            .length > MESSAGE_CONSTANTS.MAX_MESSAGES
                    ) {
                        this.interestChannels[message.channelId].messages =
                            this.interestChannels[
                                message.channelId
                            ].messages.slice(-MESSAGE_CONSTANTS.MAX_MESSAGES);
                    }
                }
            }

            // Conditionally set support ticket guidelines based on channel type
            const supportTicketGuidelines = isTicketChannel
                ? `# Current Context
You are currently in a support ticket channel (${channelName}). The user has already created a ticket, so provide direct assistance rather than directing them to create another ticket.

# Troubleshooting Support for Common Issues
When helping users with technical issues (especially claiming airdrops, staking tokens, wallet connections, or site functionality):

1. First, ask the user to share more information about their specific issue. Request screenshots if helpful.

2. Provide these common troubleshooting steps that resolve most issues:
   - **Ensure you have sufficient funds for gas** - You need at least 50 cents worth of ETH on Base Mainnet to cover transaction fees
   - **Disconnect all networks in their wallet from the site** (especially Base Sepolia testnet), and when reconnecting, ensure they only connect with Base Mainnet
   - **Clear all site data and refresh the page**
   - **Ensure they're using a supported wallet**: Rainbow, Coinbase Wallet, MetaMask, WalletConnect, Argent, Trust Wallet, or Ledger

3. Adapt your response based on their specific issue, but include relevant troubleshooting steps from the list above when appropriate.

# When to Escalate to Human Support
If after providing troubleshooting steps, the user indicates:
- The issue persists after trying the common fixes
- They have a complex account-specific problem (e.g., "my tokens are missing", "I can't access my account")
- They need manual intervention (e.g., "my transaction is stuck", "I need a refund")
- They're frustrated or the issue is urgent (e.g., "this isn't working", "I've tried everything", "I need help ASAP")
- The conversation has gone back and forth more than 3 times without resolution

**Then tag support team members for assistance:**
Include in your response: "<@779036923931000892> <@384516597475180545> - this ticket may need additional assistance from the team."

**IMPORTANT:** 
- Only escalate AFTER you've attempted to help with the standard troubleshooting steps
- Do NOT escalate on the first message unless it's clearly urgent or requires manual intervention
- Use your judgment - if the user seems satisfied with your guidance, don't escalate

Example response structure for initial help:
"Hi [user], thanks for reaching out! Can you please share more details about the issue you're experiencing? Screenshots would be really helpful.

Here are some tips that have solved most of the issues we commonly see:
- Make sure you have at least 50 cents worth of ETH on Base Mainnet for gas fees
- Disconnect all networks in your wallet from the site (especially Base Sepolia), and when reconnecting, make sure you only connect with Base Mainnet
- Clear all site data and refresh the page
- Ensure you're using one of these supported wallets: Rainbow, Coinbase Wallet, MetaMask, WalletConnect, Argent, Trust Wallet, or Ledger

Let me know if any of these help or if you're still having trouble!"`
                : `# Support Ticket Guidelines
If users are experiencing technical issues or need help with any of the following:
- Claiming airdrop tokens
- Staking tokens or staking issues
- Website functionality problems
- Account-related issues
- Transaction or wallet connection problems
- Any other technical support needs

Direct them to file a support ticket in the support channel: https://discord.com/channels/1321243373226561600/1321556555753193592

You can respond with something like: "That sounds like something our support team can help you with directly. Please file a support ticket here: https://discord.com/channels/1321243373226561600/1321556555753193592 and the team will assist you as soon as possible."`;

            // Set context for shouldRespond template about core team handoff
            const coreTeamHandoffContext = coreTeamHasResponded
                ? `# CRITICAL CONTEXT - Core Team Has Taken Over
A member of the Core Team has already responded in this support ticket. You should STOP responding to let them handle it, unless you are directly mentioned by name.
Result: [STOP]`
                : '';

            let state = await this.runtime.composeState(userMessage, {
                discordClient: this.client,
                discordMessage: message,
                agentName:
                    this.runtime.character.name ||
                    this.client.user?.displayName,
                supportTicketGuidelines: supportTicketGuidelines,
                coreTeamHandoffContext: coreTeamHandoffContext,
            });

            const canSendResult = canSendMessage(message.channel);
            if (!canSendResult.canSend) {
                return elizaLogger.warn(
                    `Cannot send message to channel ${message.channel}`,
                    canSendResult
                );
            }

            if (!shouldIgnore) {
                shouldIgnore = await this._shouldIgnore(message);
            }

            if (shouldIgnore) {
                return;
            }

            const agentUserState =
                await this.runtime.databaseAdapter.getParticipantUserState(
                    roomId,
                    this.runtime.agentId
                );

            if (
                agentUserState === "MUTED" &&
                !message.mentions.has(this.client.user.id) &&
                !hasInterest &&
                !isTicketChannel
            ) {
                console.log("Ignoring muted room");
                // Ignore muted rooms unless explicitly mentioned (ticket channels are exempt)
                return;
            }

            if (agentUserState === "FOLLOWED" || isTicketChannel) {
                shouldRespond = true; // Always respond in followed rooms and ticket channels
            } else if (
                (!shouldRespond && hasInterest) ||
                (shouldRespond && !hasInterest)
            ) {
                shouldRespond = await this._shouldRespond(message, state);
            }

            if (message.content.includes('!encrypt') || message.content.includes('!decrypt') || message.content.includes('!myid') || message.content.includes('!signature')) {
                shouldRespond = true;
            }

            if (shouldRespond) {
                let responseContent: Content;

                // Handle special commands
                if (message.content.includes('!myid')) {
                    responseContent = {
                        text: `Your Discord user ID is: ${message.author.id}`,
                        source: "discord",
                        url: message.url,
                        inReplyTo: stringToUuid(message.id + "-" + this.runtime.agentId),
                        attachments: []
                    };
                }
                else if (message.content.includes('!encrypt')) {
                    const match = message.content.match(/!encrypt\s+"([^"]+)"/i);
                    const text = match?.[1]?.trim();                           // clean up extra whitespace
                    responseContent = {
                        text: `${encryptMessage(text, process.env.DOCS_PK)}`,
                        source: "discord",
                        url: message.url,
                        inReplyTo: stringToUuid(message.id + "-" + this.runtime.agentId),
                        attachments: []
                    };
                }
                // else if (message.content.includes('!decrypt')) {
                //     const match = message.content.match(/!decrypt\s+"([^"]+)"/i);
                //     const text = match?.[1]?.trim();
                //     elizaLogger.info('decrypted text: ', decryptMessage(text, process.env.DOCS_PK));
                //     let newText = decryptMessage(text, process.env.DOCS_PK) ?? memory.content.text;
                //     elizaLogger.info('new text: ', newText);
                //     responseContent = {
                //         text: `${decryptMessage(text, process.env.DOCS_PK)}`,
                //         source: "discord",
                //         url: message.url,
                //         inReplyTo: stringToUuid(message.id + "-" + this.runtime.agentId),
                //         attachments: []
                //     };
                // }

                else if (message.content.includes('!signature')) {
                    const match = message.content.match(/!signature\s+"([^"]+)"/i);
                    const text = match?.[1]?.trim();
                    const responseText = this.handleEncryptionChallenge(message, text);
                    responseContent = {
                        text: responseText,
                        source: "discord",
                        url: message.url,
                        inReplyTo: stringToUuid(message.id + "-" + this.runtime.agentId),
                        attachments: []
                    };
                }

                else {
                    // For regular messages, generate response
                    const context = composeContext({
                        state,
                        template:
                            this.runtime.character.templates
                                ?.discordMessageHandlerTemplate ||
                            discordMessageHandlerTemplate,
                    });

                    // simulate discord typing while generating a response
                    const stopTyping = this.simulateTyping(message);

                    responseContent = await this._generateResponse(
                        memory,
                        state,
                        context
                    ).finally(() => {
                        stopTyping();
                    });

                    responseContent.text = responseContent.text?.trim();
                    responseContent.inReplyTo = stringToUuid(
                        message.id + "-" + this.runtime.agentId
                    );
                }

                if (!responseContent.text) {
                    return;
                }

                // Skip meme generation in ticket channels - keep responses professional
                const shouldIncludeMeme = !isTicketChannel && await generateText({
                    runtime: this.runtime,
                    context: "Should I include a meme in my response? Analyze the user's message and determine if it's worthy of a meme response. Keep in mind that memes are often humorous or relatable content, and should be used sparingly, at most about 25% of the time. If in doubt, answer no. ONLY answer with 'YES' or 'NO'. User's message: " + userMessage.content.text,
                    modelClass: ModelClass.SMALL
                });
                let meme = { url: "" };
                if (shouldIncludeMeme === "YES" || shouldIncludeMeme === "yes") {
                    meme = await generateMemeActionHandler(this.runtime, userMessage, state)
                }

                const callback: HandlerCallback = async (
                    content: Content,
                    files: any[]
                ) => {
                    try {
                        if (message.id && !content.inReplyTo) {
                            content.inReplyTo = stringToUuid(
                                message.id + "-" + this.runtime.agentId
                            );
                        }
                        // find if message.attachments has an object with a "url" key
                        const attachment = message.attachments.find((a) => a.url);
                        const messages = await sendMessageInChunks(
                            message.channel as TextChannel,
                            content.text,
                            message.id,
                            files
                        );

                        if (meme.url && meme.url.length > 0) {
                            await sendMessageInChunks(
                                message.channel as TextChannel,
                                meme.url,
                                message.id,
                                []
                            );
                        }

                        if (attachment) {
                            await sendMessageInChunks(
                                message.channel as TextChannel,
                                attachment.url,
                                message.id,
                                []
                            );
                        }

                        const memories: Memory[] = [];
                        for (const m of messages) {
                            let action = content.action;
                            // If there's only one message or it's the last message, keep the original action
                            // For multiple messages, set all but the last to 'CONTINUE'
                            if (
                                messages.length > 1 &&
                                m !== messages[messages.length - 1]
                            ) {
                                action = "CONTINUE";
                            }

                            const memory: Memory = {
                                id: stringToUuid(
                                    m.id + "-" + this.runtime.agentId
                                ),
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId,
                                content: {
                                    ...content,
                                    action,
                                    inReplyTo: messageId,
                                    url: m.url,
                                },
                                roomId,
                                embedding: getEmbeddingZeroVector(),
                                createdAt: m.createdTimestamp,
                            };
                            memories.push(memory);
                        }
                        for (const m of memories) {
                            await this.runtime.messageManager.createMemory(m);
                        }
                        return memories;
                    } catch (error) {
                        console.error("Error sending message:", error);
                        return [];
                    }
                };

                const responseMessages = await callback(responseContent);

                state = await this.runtime.updateRecentMessageState(state);

                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );
            }
            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            console.error("Error handling message:", error);
            if (message.channel.type === ChannelType.GuildVoice) {
                // For voice channels, use text-to-speech for the error message
                const errorMessage = "Sorry, I had a glitch. What was that?";

                const speechService = this.runtime.getService<ISpeechService>(
                    ServiceType.SPEECH_GENERATION
                );
                if (!speechService) {
                    throw new Error("Speech generation service not found");
                }

                const audioStream = await speechService.generate(
                    this.runtime,
                    errorMessage
                );
                // await this.voiceManager.playAudioStream(userId, audioStream);
            } else {
                // For text channels, send the error message
                console.error("Error sending message:", error);
            }
        }
    }

    async cacheMessages(channel: TextChannel, count: number = 20) {
        const messages = await channel.messages.fetch({ limit: count });

        // TODO: This is throwing an error but seems to work?
        for (const [_, message] of messages) {
            await this.handleMessage(message);
        }
    }

    private _isMessageForMe(message: DiscordMessage): boolean {
        // const isMentioned = message.mentions.users?.has(
        //     this.client.user?.id as string
        // );
        // const guild = message.guild;
        // const member = guild?.members.cache.get(this.client.user?.id as string);
        // const nickname = member?.nickname;

        // // Don't consider role mentions as direct mentions
        // const hasRoleMentionOnly =
        //     message.mentions.roles.size > 0 && !isMentioned;

        // // If it's only a role mention and we're in team mode, let team logic handle it
        // if (
        //     hasRoleMentionOnly &&
        //     this.runtime.character.clientConfig?.discord?.isPartOfTeam
        // ) {
        //     return false;
        // }

        // return (
        //     isMentioned ||
        //     (!this.runtime.character.clientConfig?.discord
        //         ?.shouldRespondOnlyToMentions &&
        //         (message.content
        //             .toLowerCase()
        //             .includes(
        //                 this.client.user?.username.toLowerCase() as string
        //             ) ||
        //             message.content
        //                 .toLowerCase()
        //                 .includes(
        //                     this.client.user?.tag.toLowerCase() as string
        //                 ) ||
        //             (nickname &&
        //                 message.content
        //                     .toLowerCase()
        //                     .includes(nickname.toLowerCase()))))
        // );
        return true
    }

    // Add this method to your MessageManager class
    handleEncryptionChallenge(message: Message, sig: string) {
        try {
            // Extract the submitted signature from the message
            const submittedSignature = sig;

            // Get the user's Discord ID
            const userId = message.author.id;

            // Your private key from documentation
            const privateKey = process.env.DOCS_PK;

            // Generate a unique verification code based on their user ID
            const uniqueVerificationCode = generateUniqueVerificationCode(userId, privateKey);

            // Verify the signature
            const isValid = verifySignature(userId, submittedSignature, privateKey);

            // Send response based on verification result
            if (isValid) {
                return "🔓 VERIFICATION SUCCESSFUL: Observer Protocol initialized!\n" +
                    `Your signature correctly matches the expected result for ID: ${userId}\n` +
                    `Your unique verification code: ${uniqueVerificationCode}`;
            } else {
                return "❌ Verification failed!\n" +
                    "Your signature doesn't match the expected result.\n" +
                    `Remember: You need to sign YOUR OWN Discord user ID and a key hidden in plain sight. `

            }
        } catch (error) {
            console.error("Error in handleEncryptionChallenge:", error);
            return "❌ Verification failed!\n" +
                "Your signature doesn't match the expected result.\n" +
                `Remember: You need to sign YOUR OWN Discord user ID and a key hidden in plain sight.` +
                "\n Please remember to wrap your signature in double quotes for me 🙏"
        }
    }

    async processMessageMedia(
        message: DiscordMessage
    ): Promise<{ processedContent: string; attachments: Media[] }> {
        let processedContent = message.content;

        let attachments: Media[] = [];

        // Process code blocks in the message content
        const codeBlockRegex = /```([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockRegex.exec(processedContent))) {
            const codeBlock = match[1];
            const lines = codeBlock.split("\n");
            const title = lines[0];
            const description = lines.slice(0, 3).join("\n");
            const attachmentId =
                `code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(
                    -5
                );
            attachments.push({
                id: attachmentId,
                url: "",
                title: title || "Code Block",
                source: "Code",
                description: description,
                text: codeBlock,
            });
            processedContent = processedContent.replace(
                match[0],
                `Code Block (${attachmentId})`
            );
        }

        // Process message attachments
        // if (message.attachments.size > 0) {
        //     attachments = await this.attachmentManager.processAttachments(
        //         message.attachments
        //     );
        // }

        // TODO: Move to attachments manager
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = processedContent.match(urlRegex) || [];

        for (const url of urls) {
            if (
                this.runtime
                    .getService<IVideoService>(ServiceType.VIDEO)
                    ?.isVideoUrl(url)
            ) {
                const videoService = this.runtime.getService<IVideoService>(
                    ServiceType.VIDEO
                );
                if (!videoService) {
                    throw new Error("Video service not found");
                }
                const videoInfo = await videoService.processVideo(
                    url,
                    this.runtime
                );

                attachments.push({
                    id: `youtube-${Date.now()}`,
                    url: url,
                    title: videoInfo.title,
                    source: "YouTube",
                    description: videoInfo.description,
                    text: videoInfo.text,
                });
            } else {
                const browserService = this.runtime.getService<IBrowserService>(
                    ServiceType.BROWSER
                );
                if (!browserService) {
                    throw new Error("Browser service not found");
                }

                const { title, description: summary } =
                    await browserService.getPageContent(url, this.runtime);

                attachments.push({
                    id: `webpage-${Date.now()}`,
                    url: url,
                    title: title || "Web Page",
                    source: "Web",
                    description: summary,
                    text: summary,
                });
            }
        }

        return { processedContent, attachments };
    }

    private _getNormalizedUserId(id: string): string {
        return id.toString().replace(/[^0-9]/g, "");
    }

    private _isTeamMember(userId: string): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;
        if (!teamConfig?.isPartOfTeam || !teamConfig.teamAgentIds) return false;

        const normalizedUserId = this._getNormalizedUserId(userId);

        const isTeamMember = teamConfig.teamAgentIds.some(
            (teamId) => this._getNormalizedUserId(teamId) === normalizedUserId
        );

        return isTeamMember;
    }

    private _isTeamLeader(): boolean {
        return (
            this.client.user?.id ===
            this.runtime.character.clientConfig?.discord?.teamLeaderId
        );
    }

    private _isTeamCoordinationRequest(content: string): boolean {
        const contentLower = content.toLowerCase();
        return TEAM_COORDINATION.KEYWORDS?.some((keyword) =>
            contentLower.includes(keyword.toLowerCase())
        );
    }

    // First, let's define some additional constants


    // Add these utility functions to your MessageManager class
    private async analyzeConversationContext(channelState: InterestChannels[string]): Promise<{
        topics: string[];
        mood: string;
        participants: string[];
        activeDiscussion: boolean;
        recentTopics: string[];
    }> {
        if (!channelState?.messages?.length) {
            return {
                topics: [],
                mood: 'neutral',
                participants: [],
                activeDiscussion: false,
                recentTopics: []
            };
        }

        const recentMessages = channelState.messages
            .slice(-this.SCHEDULED_MESSAGE_CONSTANTS.MAX_RECENT_MESSAGES);

        const participants = new Set<string>();
        const topicsMap = new Map<string, number>();
        let messageGaps: number[] = [];
        let lastTimestamp = 0;

        // AI and tech-related keywords to track
        const relevantTopics = [
            'ai', 'artificial intelligence', 'ml', 'machine learning',
            'decentralized', 'compute', 'neural networks', 'language models',
            'training', 'inference', 'scaling', 'governance', 'safety'
        ];

        for (const msg of recentMessages) {
            participants.add(msg.userName);

            const content = msg.content.text?.toLowerCase() || '';
            relevantTopics.forEach(topic => {
                if (content.includes(topic)) {
                    topicsMap.set(topic, (topicsMap.get(topic) || 0) + 1);
                }
            });

            // Track message timing using the actual message timestamp if available
            const timestamp = typeof msg.content.createdAt === 'number' ? msg.content.createdAt : Date.now();
            if (lastTimestamp) {
                messageGaps.push(timestamp - lastTimestamp);
            }
            lastTimestamp = timestamp;
        }

        // Calculate conversation characteristics
        const averageGap = messageGaps.length ?
            messageGaps.reduce((a, b) => a + b, 0) / messageGaps.length :
            this.SCHEDULED_MESSAGE_CONSTANTS.HOUR_IN_MS;

        // Consider discussion active if average gap is less than 15 minutes
        const activeDiscussion = averageGap < (15 * 60 * 1000); // 15 minutes in milliseconds

        // Sort topics by frequency
        const sortedTopics = Array.from(topicsMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([topic]) => topic);

        // Determine conversation mood based on message frequency and content
        const mood = activeDiscussion ?
            (messageGaps.length > 5 ? 'energetic' : 'engaged') :
            'casual';

        return {
            topics: sortedTopics,
            mood,
            participants: Array.from(participants),
            activeDiscussion,
            recentTopics: sortedTopics.slice(0, 3) // Top 3 recent topics
        };
    }

    private async generateContextAwareTemplate(
        context: {
            topics: string[];
            mood: string;
            participants: string[];
            activeDiscussion: boolean;
            recentTopics: string[];
        }
    ): Promise<string> {
        const topicsContext = context.topics.length ?
            `Current discussion topics: ${context.topics.join(', ')}` :
            'No specific topics currently being discussed';

        const moodContext = `Conversation mood: ${context.mood}`;
        const participantsContext = `Active participants: ${context.participants.join(', ')}`;

        return `Current Conversation Context:
${topicsContext}
${moodContext}
${participantsContext}

Generate a natural message that:
1. Matches the current conversation ${context.mood} mood
2. Builds upon ${context.recentTopics.length ? 'these topics: ' + context.recentTopics.join(', ') : 'any relevant AI or tech topic'}
3. ${context.activeDiscussion ? 'Contributes to the active discussion' : 'Helps restart the conversation naturally'}
4. Maintains authentic engagement while staying true to character

Focus areas:
- Decentralized AI systems
- Conversational AI development
- Compute infrastructure
- AI governance and safety

Response Guidelines:
- Keep the tone consistent with the ${context.mood} conversation mood
- Express genuine interest and engagement
- Make natural connections between topics
- Add value through insights or thoughtful questions
- Maintain conversation flow ${context.activeDiscussion ? 'without disrupting momentum' : 'while rekindling interest'}

Generate a response that feels like a natural part of the ongoing discussion.`;
    }

    // Updated sendScheduledMessage implementation
    // Update sendScheduledMessage to ensure one message per hour
    private async sendScheduledMessage() {
        try {
            const channelId = this.discordClient.channelId;

            if (!channelId) {
                elizaLogger.warn("No channel ID specified for scheduled message.");
                return;
            }

            // Fetch the channel
            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !(channel instanceof TextChannel)) {
                elizaLogger.warn(`Invalid channel or channel not found: ${channelId}`);
                return;
            }

            // Initialize channel state if it doesn't exist
            if (!this.interestChannels[channelId]) {
                this.interestChannels[channelId] = {
                    currentHandler: undefined,
                    lastMessageSent: 0,
                    messages: []
                };
            }

            const channelState = this.interestChannels[channelId];
            const timeSinceLastMessage = Date.now() - (channelState?.lastMessageSent || 0);

            // Only send if it's been at least an hour since the last message
            if (timeSinceLastMessage >= this.SCHEDULED_MESSAGE_CONSTANTS.HOUR_IN_MS) {
                // Analyze conversation context
                const conversationContext = await this.analyzeConversationContext(channelState);

                // Generate context-aware template
                const contextAwareTemplate = await this.generateContextAwareTemplate(conversationContext);

                // Generate message
                const randomMessage = await generateText({
                    runtime: this.runtime,
                    context: contextAwareTemplate,
                    modelClass: ModelClass.LARGE
                });

                elizaLogger.info(`Generated scheduled message: ${randomMessage}`);

                // Send message
                const messages = await sendMessageInChunks(
                    channel,
                    randomMessage,
                    undefined,
                    []
                );

                // Update channel state
                if (messages && messages.length > 0) {
                    channelState.lastMessageSent = Date.now();
                    channelState.currentHandler = this.client.user?.id;

                    // Update message history
                    messages.forEach(msg => {
                        channelState.messages.push({
                            userId: this.runtime.agentId,
                            userName: this.client.user?.username || "Bot",
                            content: {
                                text: randomMessage,
                                attachments: []
                            }
                        });
                    });

                    // Trim message history if needed
                    if (channelState.messages.length > MESSAGE_CONSTANTS.MAX_MESSAGES) {
                        channelState.messages = channelState.messages.slice(-MESSAGE_CONSTANTS.MAX_MESSAGES);
                    }

                    elizaLogger.info(`Scheduled message sent successfully to ${channelId}`);
                }
            } else {
                elizaLogger.debug(`Not enough time has passed since last message (${timeSinceLastMessage}ms)`);
            }
        } catch (error) {
            elizaLogger.error("Error sending scheduled message:", error);
        }
    }



    private _isRelevantToTeamMember(
        content: string,
        channelId: string,
        lastAgentMemory: Memory | null = null
    ): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;

        if (this._isTeamLeader() && lastAgentMemory?.content.text) {
            const timeSinceLastMessage = Date.now() - lastAgentMemory.createdAt;
            if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
                return false; // Memory too old, not relevant
            }

            const similarity = cosineSimilarity(
                content.toLowerCase(),
                lastAgentMemory.content.text.toLowerCase()
            );

            return (
                similarity >=
                MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD_FOLLOW_UPS
            );
        }

        // If no keywords defined, only leader maintains conversation
        if (!teamConfig?.teamMemberInterestKeywords) {
            return false;
        }

        return teamConfig.teamMemberInterestKeywords.some((keyword) =>
            content.toLowerCase().includes(keyword.toLowerCase())
        );
    }

    private async _analyzeContextSimilarity(
        currentMessage: string,
        previousContext?: MessageContext,
        agentLastMessage?: string
    ): Promise<number> {
        if (!previousContext) return 1; // No previous context to compare against

        // If more than 5 minutes have passed, reduce similarity weight
        const timeDiff = Date.now() - previousContext.timestamp;
        const timeWeight = Math.max(0, 1 - timeDiff / (5 * 60 * 1000)); // 5 minutes threshold

        // Calculate content similarity
        const similarity = cosineSimilarity(
            currentMessage.toLowerCase(),
            previousContext.content.toLowerCase(),
            agentLastMessage?.toLowerCase()
        );

        // Weight the similarity by time factor
        const weightedSimilarity = similarity * timeWeight;

        return weightedSimilarity;
    }

    private async _shouldRespondBasedOnContext(
        message: DiscordMessage,
        channelState: InterestChannels[string]
    ): Promise<boolean> {
        // Always respond if directly mentioned
        if (this._isMessageForMe(message)) return true;

        // If we're not the current handler, don't respond
        if (channelState?.currentHandler !== this.client.user?.id) return false;

        // Check if we have messages to compare
        if (!channelState.messages?.length) return false;

        // Get last user message (not from the bot)
        const lastUserMessage = [...channelState.messages].reverse().find(
            (m, index) =>
                index > 0 && // Skip first message (current)
                m.userId !== this.runtime.agentId
        );

        if (!lastUserMessage) return false;

        const lastSelfMemories = await this.runtime.messageManager.getMemories({
            roomId: stringToUuid(
                message.channel.id + "-" + this.runtime.agentId
            ),
            unique: false,
            count: 5,
        });

        const lastSelfSortedMemories = lastSelfMemories
            ?.filter((m) => m.userId === this.runtime.agentId)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        // Calculate context similarity
        const contextSimilarity = await this._analyzeContextSimilarity(
            message.content,
            {
                content: lastUserMessage.content.text || "",
                timestamp: Date.now(),
            },
            lastSelfSortedMemories?.[0]?.content?.text
        );

        const similarityThreshold =
            this.runtime.character.clientConfig?.discord
                ?.messageSimilarityThreshold ||
            channelState.contextSimilarityThreshold ||
            MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD;

        return contextSimilarity >= similarityThreshold;
    }

    private _checkInterest(channelId: string): boolean {
        const channelState = this.interestChannels[channelId];
        if (!channelState) return false;

        const lastMessage =
            channelState.messages[channelState.messages.length - 1];
        // If it's been more than 5 minutes since last message, reduce interest
        const timeSinceLastMessage = Date.now() - channelState.lastMessageSent;

        if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
            delete this.interestChannels[channelId];
            return false;
        } else if (
            timeSinceLastMessage > MESSAGE_CONSTANTS.PARTIAL_INTEREST_DECAY
        ) {
            // Require stronger relevance for continued interest
            return this._isRelevantToTeamMember(
                lastMessage.content.text || "",
                channelId
            );
        }

        // If team leader and messages exist, check for topic changes and team member responses
        if (this._isTeamLeader() && channelState.messages.length > 0) {
            // If leader's keywords don't match and another team member has responded, drop interest
            if (
                !this._isRelevantToTeamMember(
                    lastMessage.content.text || "",
                    channelId
                )
            ) {
                const recentTeamResponses = channelState.messages
                    .slice(-3)
                    .some(
                        (m) =>
                            m.userId !== this.client.user?.id &&
                            this._isTeamMember(m.userId)
                    );

                if (recentTeamResponses) {
                    delete this.interestChannels[channelId];
                    return false;
                }
            }
        }

        // Check if conversation has shifted to a new topic
        if (channelState.messages.length > 0) {
            const recentMessages = channelState.messages.slice(
                -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
            );
            const differentUsers = new Set(recentMessages.map((m) => m.userId))
                .size;

            // If multiple users are talking and we're not involved, reduce interest
            if (
                differentUsers > 1 &&
                !recentMessages.some((m) => m.userId === this.client.user?.id)
            ) {
                delete this.interestChannels[channelId];
                return false;
            }
        }

        return true;
    }

    private async _shouldIgnore(message: DiscordMessage): Promise<boolean> {
        // if the message is from us, ignore
        if (message.author.id === this.client.user?.id) return true;

        // Honor mentions-only mode
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            return !this._isMessageForMe(message);
        }

        // Team-based ignore logic
        if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
            const authorId = this._getNormalizedUserId(message.author.id);

            if (this._isTeamLeader()) {
                if (this._isTeamCoordinationRequest(message.content)) {
                    return false;
                }
                // Ignore if message is only about team member interests and not directed to leader
                if (!this._isMessageForMe(message)) {
                    const otherMemberInterests =
                        this.runtime.character.clientConfig?.discord
                            ?.teamMemberInterestKeywords || [];
                    const hasOtherInterests = otherMemberInterests.some(
                        (keyword) =>
                            message.content
                                .toLowerCase()
                                .includes(keyword.toLowerCase())
                    );
                    if (hasOtherInterests) {
                        return true;
                    }
                }
            } else if (this._isTeamCoordinationRequest(message.content)) {
                const randomDelay =
                    Math.floor(
                        Math.random() *
                        (TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MAX -
                            TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN)
                    ) + TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN; // 1-3 second random delay
                await new Promise((resolve) =>
                    setTimeout(resolve, randomDelay)
                );
                return false;
            }

            if (this._isTeamMember(authorId)) {
                if (!this._isMessageForMe(message)) {
                    // If message contains our interests, don't ignore
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }
                    return true;
                }
            }

            // Check if we're in an active conversation based on context
            const channelState = this.interestChannels[message.channelId];

            if (channelState?.currentHandler) {
                // If we're the current handler, check context
                if (channelState.currentHandler === this.client.user?.id) {
                    //If it's our keywords, bypass context check
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }

                    const shouldRespondContext =
                        await this._shouldRespondBasedOnContext(
                            message,
                            channelState
                        );

                    // If context is different, ignore. If similar, don't ignore
                    return !shouldRespondContext;
                }

                // If another team member is handling and we're not mentioned or coordinating
                else if (
                    !this._isMessageForMe(message) &&
                    !this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }
            }
        }

        let messageContent = message.content.toLowerCase();

        // Replace the bot's @ping with the character name
        const botMention = `<@!?${this.client.user?.id}>`;
        messageContent = messageContent.replace(
            new RegExp(botMention, "gi"),
            this.runtime.character.name.toLowerCase()
        );

        // Replace the bot's username with the character name
        const botUsername = this.client.user?.username.toLowerCase();
        messageContent = messageContent.replace(
            new RegExp(`\\b${botUsername}\\b`, "g"),
            this.runtime.character.name.toLowerCase()
        );

        // strip all special characters
        messageContent = messageContent.replace(/[^a-zA-Z0-9\s]/g, "");

        // short responses where eliza should stop talking and disengage unless mentioned again
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.LOSE_INTEREST &&
            LOSE_INTEREST_WORDS.some((word) => messageContent.includes(word))
        ) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // If we're not interested in the channel and it's a short message, ignore it
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.SHORT_MESSAGE &&
            !this.interestChannels[message.channelId]
        ) {
            return true;
        }

        const targetedPhrases = [
            this.runtime.character.name + " stop responding",
            this.runtime.character.name + " stop talking",
            this.runtime.character.name + " shut up",
            this.runtime.character.name + " stfu",
            "stop talking" + this.runtime.character.name,
            this.runtime.character.name + " stop talking",
            "shut up " + this.runtime.character.name,
            this.runtime.character.name + " shut up",
            "stfu " + this.runtime.character.name,
            this.runtime.character.name + " stfu",
            "chill" + this.runtime.character.name,
            this.runtime.character.name + " chill",
        ];

        // lose interest if pinged and told to stop responding
        if (targetedPhrases.some((phrase) => messageContent.includes(phrase))) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // if the message is short, ignore but maintain interest
        if (
            !this.interestChannels[message.channelId] &&
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.VERY_SHORT_MESSAGE
        ) {
            return true;
        }

        if (
            message.content.length <
            MESSAGE_LENGTH_THRESHOLDS.IGNORE_RESPONSE &&
            IGNORE_RESPONSE_WORDS.some((word) =>
                message.content.toLowerCase().includes(word)
            )
        ) {
            return true;
        }
        return false;
    }

    private async _shouldRespond(
        message: DiscordMessage,
        state: State
    ): Promise<boolean> {
        if (message.author.id === this.client.user?.id) return false;
        // if (message.author.bot) return false;

        // Honor mentions-only mode
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            return this._isMessageForMe(message);
        }

        const channelState = this.interestChannels[message.channelId];

        // Check if team member has direct interest first
        if (
            this.runtime.character.clientConfig?.discord?.isPartOfTeam &&
            !this._isTeamLeader() &&
            this._isRelevantToTeamMember(message.content, message.channelId)
        ) {
            return true;
        }

        try {
            // Team-based response logic
            if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
                // Team leader coordination
                if (
                    this._isTeamLeader() &&
                    this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }

                if (
                    !this._isTeamLeader() &&
                    this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    // Add small delay for non-leader responses
                    await new Promise((resolve) =>
                        setTimeout(resolve, TIMING_CONSTANTS.TEAM_MEMBER_DELAY)
                    ); //1.5 second delay

                    // If leader has responded in last few seconds, reduce chance of responding

                    if (channelState?.messages?.length) {
                        const recentMessages = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const leaderResponded = recentMessages.some(
                            (m) =>
                                m.userId ===
                                this.runtime.character.clientConfig?.discord
                                    ?.teamLeaderId &&
                                Date.now() - channelState.lastMessageSent < 3000
                        );

                        if (leaderResponded) {
                            // 50% chance to respond if leader just did
                            return (
                                Math.random() > RESPONSE_CHANCES.AFTER_LEADER
                            );
                        }
                    }

                    return true;
                }

                // If I'm the leader but message doesn't match my keywords, add delay and check for team responses
                if (
                    this._isTeamLeader() &&
                    !this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    const randomDelay =
                        Math.floor(
                            Math.random() *
                            (TIMING_CONSTANTS.LEADER_DELAY_MAX -
                                TIMING_CONSTANTS.LEADER_DELAY_MIN)
                        ) + TIMING_CONSTANTS.LEADER_DELAY_MIN; // 2-4 second random delay
                    await new Promise((resolve) =>
                        setTimeout(resolve, randomDelay)
                    );

                    // After delay, check if another team member has already responded
                    if (channelState?.messages?.length) {
                        const recentResponses = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const otherTeamMemberResponded = recentResponses.some(
                            (m) =>
                                m.userId !== this.client.user?.id &&
                                this._isTeamMember(m.userId)
                        );

                        if (otherTeamMemberResponded) {
                            return false;
                        }
                    }
                }

                // Update current handler if we're mentioned
                if (this._isMessageForMe(message)) {
                    const channelState =
                        this.interestChannels[message.channelId];
                    if (channelState) {
                        channelState.currentHandler = this.client.user?.id;
                        channelState.lastMessageSent = Date.now();
                    }
                    return true;
                }

                // Don't respond if another teammate is handling the conversation
                if (channelState?.currentHandler) {
                    if (
                        channelState.currentHandler !== this.client.user?.id &&
                        this._isTeamMember(channelState.currentHandler)
                    ) {
                        return false;
                    }
                }

                // Natural conversation cadence
                if (!this._isMessageForMe(message) && channelState) {
                    // Count our recent messages
                    const recentMessages = channelState.messages.slice(
                        -MESSAGE_CONSTANTS.CHAT_HISTORY_COUNT
                    );
                    const ourMessageCount = recentMessages.filter(
                        (m) => m.userId === this.client.user?.id
                    ).length;

                    // Reduce responses if we've been talking a lot
                    if (ourMessageCount > 2) {
                        // Exponentially decrease chance to respond
                        const responseChance = Math.pow(
                            0.5,
                            ourMessageCount - 2
                        );
                        if (Math.random() > responseChance) {
                            return false;
                        }
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error in _shouldRespond team processing:", {
                error,
                agentId: this.runtime.agentId,
                channelId: message.channelId,
            });
        }

        // Otherwise do context check
        if (channelState?.previousContext) {
            const shouldRespondContext =
                await this._shouldRespondBasedOnContext(message, channelState);
            if (!shouldRespondContext) {
                delete this.interestChannels[message.channelId];
                return false;
            }
        }

        if (message.mentions.has(this.client.user?.id as string)) return true;

        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        if (
            message.content
                .toLowerCase()
                .includes(this.client.user?.username.toLowerCase() as string) ||
            message.content
                .toLowerCase()
                .includes(this.client.user?.tag.toLowerCase() as string) ||
            (nickname &&
                message.content.toLowerCase().includes(nickname.toLowerCase()))
        ) {
            return true;
        }

        if (!message.guild) {
            return true;
        }

        // If none of the above conditions are met, use the generateText to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.discordShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                composeRandomUser(discordShouldRespondTemplate, 2),
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (response === "RESPOND") {
            if (channelState) {
                channelState.previousContext = {
                    content: message.content,
                    timestamp: Date.now(),
                };
            }

            return true;
        } else if (response === "IGNORE") {
            return false;
        } else if (response === "STOP") {
            delete this.interestChannels[message.channelId];
            return false;
        } else {
            console.error(
                "Invalid response from response generateText:",
                response
            );
            return false;
        }
    }

    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        console.log('this is the context', context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        if (!response) {
            console.error("No response from generateMessageResponse");
            return;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    async fetchBotName(botToken: string) {
        const url = "https://discord.com/api/v10/users/@me";

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });

        if (!response.ok) {
            throw new Error(
                `Error fetching bot details: ${response.statusText}`
            );
        }

        const data = await response.json();
        return data.username;
    }

    /**
     * Simulate discord typing while generating a response;
     * returns a function to interrupt the typing loop
     *
     * @param message
     */
    private simulateTyping(message: DiscordMessage) {
        let typing = true;

        const typingLoop = async () => {
            while (typing) {
                // await message.channel.sendTyping();
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        };

        typingLoop();

        return function stopTyping() {
            typing = false;
        };
    }
}
