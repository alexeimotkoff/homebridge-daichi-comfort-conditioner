export class MqttUser {
    constructor(
      public readonly userName: string,
      public readonly password: string,
      public readonly userId: number) {

    }
}