const { Client, ITEMS_HANDLING_FLAGS, COMMON_TAGS, SERVER_PACKET_TYPE, ConnectionStatus, CLIENT_PACKET_TYPE, PRINT_JSON_TYPE  } = require('archipelago.js');
const { User, MessageFlags } = require('discord.js');
const { v4: uuid } = require('uuid');

class ArchipelagoInterface {
  /**
   * @param textChannel discord.js TextChannel
   * @param {string} host
   * @param {Number} port
   * @param {string} slotName
   * @param {string|null} password optional
   */
  constructor(textChannel, host, port, slotName, password=null) {
    this.textChannel = textChannel;
    this.messageQueue = [];
    this.players = new Map();
    this.APClient = new Client();

    this.slotName = slotName;

    // Controls which messages should be printed to the channel
    this.showHints = true;
    this.showItems = true;
    this.showProgression = true;
    this.showChat = true;
    this.showNonAliased = true;

    const connectionInfo = {
      hostname: host,
      port,
      uuid: uuid(),
      game: '',
      name: slotName,
      password: password,
      tags: [COMMON_TAGS.TEXT_ONLY],
      items_handling: ITEMS_HANDLING_FLAGS.LOCAL_ONLY,
    };

    this.APClient.connect(connectionInfo).then(() => {
      onConnected();
      // Inform the user ArchipelaBot has connected to the game
      textChannel.send('Connection established.');
    }).catch(async (err) => {
      if (Array.isArray(err)) {
        err = err[0];
      }
      console.error('Error while trying to connect with connectionInfo:');
      console.error(connectionInfo);
      console.error('With trace:');
      console.error(err);
      await this.textChannel.send('A problem occurred while connecting to the AP server:\n' +
        `\`\`\`${err.message}\`\`\``);
    });
  }

  onConnected = async() => {
      // Start handling queued messages
      this.queueTimeout = setTimeout(this.queueHandler, 5000);

      // Set up packet listeners
      // this.APClient.addListener(SERVER_PACKET_TYPE.PRINT, this.printHandler);
      this.APClient.addListener(SERVER_PACKET_TYPE.PRINT_JSON, this.printJSONHandler);
      this.APClient.addListener(SERVER_PACKET_TYPE.BOUNCED, this.bouncedHandler);

      this.bounceInterval = setInterval(this.bounce, 60000);
  };

  /**
   * Send queued messages to the TextChannel in batches of five or less
   * @returns {Promise<void>}
   */
  queueHandler = async () => {
    let messages = [];

    for (let message of this.messageQueue) {
      // Replace player names with Discord User objects
      let hasKnownAlias = this.handleAliases(message)
      if (!this.showNonAliased && !hasKnownAlias) { continue; }

      switch(message.type) {
        case 'hint':
        // Ignore hint messages if they should not be displayed
          if (!this.showHints) { continue; }
          break;

        case 'item':
        // Ignore item messages if they should not be displayed
          if (!this.showItems) { continue; }
          break;

        case 'progression':
        // Ignore progression messages if they should not be displayed
          if (!this.showProgression) { continue; }
          break;

        case 'chat':
        // Ignore chat messages if they should not be displayed
          if (!this.showChat) { continue; }
          break;

        default:
          console.warn(`Ignoring unknown message type: ${message.type}`);
          break;
      }

      messages.push(message.content);
    }

    // Clear the message queue
    this.messageQueue = [];

    // Send messages to TextChannel in batches of five, spaced two seconds apart to avoid rate limit
    while (messages.length > 0) {
      await this.textChannel.send({
        content: messages.splice(0, 5).join('\n'),
        flags: MessageFlags.SuppressNotifications,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Set timeout to run again after five seconds
    this.queueTimeout = setTimeout(this.queueHandler, 5000);
  };

  /**
   * Listen for a print packet and add that message to the message queue
   * @param {Object} packet
   * @returns {Promise<void>}
   */
  printHandler = async (packet) => {
    this.messageQueue.push({
      type: packet.text.includes('[Hint]') ? 'hint' : 'chat',
      content: packet.text,
    });
  };

  /**
   * Listen for a printJSON packet, convert it to a human-readable format, and add the message to the queue
   * @param {Object} packet
   * @param {String} rawMessage
   * @returns {Promise<void>}
   */
  printJSONHandler = async (packet, rawMessage) => {
    let message = { type: 'chat', content: '', };

    console.log(`printJSON: type:${packet.type} - message:${rawMessage}, - data:${JSON.stringify(packet.data)}`)

    if (packet.type == PRINT_JSON_TYPE.TUTORIAL) {
      // Ignore
      return
    }

    if (![PRINT_JSON_TYPE.ITEM_SEND, PRINT_JSON_TYPE.ITEM_CHEAT, PRINT_JSON_TYPE.HINT].includes(packet.type)) {
      message.content = rawMessage;
      this.messageQueue.push(message);
      return;
    }

    packet.data.forEach((part) => {
      // Plain text parts do not have a "type" property
      if (!part.hasOwnProperty('type') && part.hasOwnProperty('text')) {
        message.content += part.text;
        return;
      }

      switch(part.type){
        case 'player_id':
          message.content += '**'+this.APClient.players.alias(parseInt(part.text, 10))+'**';
          break;

        case 'item_id':
          const itemName = this.APClient.players.get(packet.receiving).item(parseInt(part.text, 10));
          message.content += `**${itemName}**`;

          // Identify this message as containing an item
          if (message.type !== 'progression') { message.type = 'item'; }

          // Identify if this message contains a progression item
          if (part?.flags === 0b001) { message.type = 'progression'; }
          break;

        case 'location_id':
          const locationName = this.APClient.players.get(packet.item.player).location(parseInt(part.text, 10));
          message.content += `**${locationName}**`;
          break;

        case 'color':
          message.content += part.text;
          break;

        default:
          console.warn(`Ignoring unknown message type ${part.type} with text "${part.text}".`);
          return;
      }
    });

    // Identify hint messages
    if (rawMessage.includes('[Hint]')) { message.type = 'hint'; }

    this.messageQueue.push(message);
  };

  bounce = async () => {
    this.APClient.send({
      cmd: CLIENT_PACKET_TYPE.BOUNCE,
      slots: [this.APClient.data.slot] // Bounce to self
    });
    this.bounceFailTimeout = setTimeout(this.bounceFail, 10000);
  };

  bouncedHandler = async (packet) => {
    clearTimeout(this.bounceFailTimeout);
  };

  bounceFail = async () => {
    await this.textChannel.send({
      content: "Bounce did not get a reply, server probably went to sleep. Will attempt to reconnect periodically.",
      flags: MessageFlags.SuppressNotifications,
    });
    this.disconnect();
    this.reconnectInterval = setInterval(this.reconnectAttempt, 30000)
  };

  reconnectAttempt = async () => {
    this.APClient.connect(connectionInfo).then(() => {
      clearTimeout(this.reconnectInterval);
      onConnected();
      textChannel.send({
        content: "Connection reestablished.",
        flags: MessageFlags.SuppressNotifications,
      });
    }).catch(async (err) => {
      if (Array.isArray(err)) {
        err = err[0];
      }
      if (err.error.code != 'ECONNREFUSED') {// Ignore connection refused
        clearTimeout(this.reconnectInterval);
        console.error('Error while trying to reconnect with connectionInfo:');
        console.error(connectionInfo);
        console.error('With trace:');
        console.error(err);

        await this.textChannel.send('A problem occurred while attempting to reconnect to the AP server:\n' +
          `\`\`\`${err.message}\`\`\``);
      }
    });
  };

  /**
   * Associate a Discord user with a specified alias
   * @param {string} alias
   * @param {User} discordUser
   * @returns {*}
   */
  setPlayer = (alias, discordUser) => this.players.set(alias, discordUser);

  /**
   * Disassociate a Discord user with a specified alias
   * @param alias
   * @returns {boolean}
   */
  unsetPlayer = (alias) => this.players.delete(alias);

  /**
   * Get the aliases map
   * @returns {Map}
   */
  getAliases = () => this.players;

  /**
   * Determine the status of the ArchipelagoClient object
   * @returns {ConnectionStatus}
   */
  getStatus = () => this.APClient.status;

  /** Close the WebSocket connection on the ArchipelagoClient object */
  disconnect = () => {
    clearTimeout(this.queueTimeout);
    clearTimeout(this.bounceInterval);
    clearTimeout(this.reconnectInterval);
    this.APClient.disconnect();
  };

  /**
   * Replaces all known aliases by their Discord User objects in the passed message
   * @param {string} alias
   * @returns {boolean} Whether an alias was found
   */
  handleAliases = (message) => {
    let hasKnownAlias = false
    for (let alias of this.players.keys()) {
      if (message.content.includes(alias)) {
        message.content = message.content.replace(alias, '@' + this.players.get(alias).displayName);
        hasKnownAlias = true
      }
    }
    return hasKnownAlias;
  }

}

module.exports = ArchipelagoInterface;
