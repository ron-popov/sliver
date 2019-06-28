/*
  Sliver Implant Framework
  Copyright (C) 2019  Bishop Fox
  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.
  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.
  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Subject, Observable, Observer } from 'rxjs';
import { TLSSocket, ConnectionOptions, TlsOptions, connect } from 'tls';
import * as pb from './pb/sliver_pb';
import * as msg from './pb/constants';

export interface RPCConfig {
  operator: string;
  lhost: string;
  lport: number;
  ca_certificate: string;
  certificate: string;
  private_key: string;
}

export class RPCClient {

  private config: RPCConfig;
  private socket: TLSSocket;
  private recvBuffer: Buffer;
  private isConnected = false;

  constructor(config: RPCConfig) {
    this.config = config;
  }

  // This method returns a Subject that shits out
  // or takes in pb.Envelopes and abstracts the byte
  // non-sense for your.
  async connect(): Promise<Subject<pb.Envelope>> {
    return new Promise(async (resolve, reject) => {
      if (this.isConnected) {
        reject('Already connected to rpc server');
      }

      const tlsSubject = await this.tlsConnect();
      this.isConnected = true;

      const envelopeObservable = Observable.create((obs: Observer<pb.Envelope>) => {
        this.recvBuffer = Buffer.alloc(0);
        tlsSubject.subscribe((data: Buffer) => {
          console.log(`Read ${data.length} bytes`);
          this.recvEnvelope(obs, data);
        });
      });

      const envelopeObserver = {
        next: (envelope: pb.Envelope) => {
          const dataBuffer = Buffer.from(envelope.serializeBinary());
          const sizeBuffer = this.toBytesUint32(dataBuffer.length);
          console.log(`Sending msg (${envelope.getType()}): ${dataBuffer.length} bytes ...`);
          tlsSubject.next(Buffer.concat([sizeBuffer, dataBuffer]));
        }
      };

      resolve(Subject.create(envelopeObserver, envelopeObservable));
    });
  }

  private recvEnvelope(obs: Observer<pb.Envelope>, recvData: Buffer) {
    this.recvBuffer = Buffer.concat([this.recvBuffer, recvData]);
    console.log(`Current recvBuffer is ${this.recvBuffer.length} bytes...`);
    if (4 <= this.recvBuffer.length) {
      const lengthBuffer = this.recvBuffer.slice(0, 4).buffer; // Convert Buffer to ArrayBuffer
      const readSize = new DataView(lengthBuffer).getUint32(0, true);
      console.log(`Recv msg length: ${readSize} bytes`);
      if (readSize <= 4 + this.recvBuffer.length) {
        console.log('Parsing envelope from recvBuffer');
        const bytes = this.recvBuffer.slice(4, 4 + readSize);
        const envelope = pb.Envelope.deserializeBinary(bytes);
        console.log(`Deseralized msg type ${envelope.getType()}`);
        this.recvBuffer = Buffer.from(this.recvBuffer.slice(4 + readSize));
        obs.next(envelope);
        this.recvEnvelope(obs, Buffer.alloc(0));
      }
    } else {
      console.log('Recv buffer does not contain enough bytes for a valid length');
    }
  }

  private toBytesUint32(num: number): Buffer {
    const arr = new ArrayBuffer(4); // an Int32 takes 4 bytes
    const view = new DataView(arr);
    view.setUint32(0, num, true); // byteOffset = 0; litteEndian = true
    return Buffer.from(arr);
  }

  get tlsOptions(): ConnectionOptions {
    return {
      ca: this.config.ca_certificate,
      key: this.config.private_key,
      cert: this.config.certificate,
      host: this.config.lhost,
      port: this.config.lport,
      rejectUnauthorized: true,

      // This should ONLY skip verifying the hostname matches the cerftificate:
      // https://nodejs.org/api/tls.html#tls_tls_checkserveridentity_hostname_cert
      checkServerIdentity: () => undefined,
    };
  }

  // This is somehow the "clean" way to do this shit...
  // tlsConnect returns a Subject that shits out Buffers
  // or takes in Buffers of an interminate size as they come
  private tlsConnect(): Promise<Subject<Buffer>> {
    return new Promise((resolve, reject) => {

      console.log(`Connecting to ${this.config.lhost}:${this.config.lport} ...`);

      // Conenct to the server
      this.socket = connect(this.tlsOptions);
      this.socket.setNoDelay(true);

      // This event fires after the tls handshake, but we need to check `socket.authorized`
      this.socket.on('secureConnect', () => {
        console.log('RPC client connected', this.socket.authorized ? 'authorized' : 'unauthorized');
        if (this.socket.authorized === true) {

          const socketObservable = Observable.create((obs: Observer<Buffer>) => {
            this.socket.on('data', (data) => {
              console.log(`Socket read ${data.length} bytes`);
              obs.next(data);
            });    // Bind observable's .next() to 'data' event
            this.socket.on('close', obs.error.bind(obs));  // same with close/error
          });

          const socketObserver = {
            next: (data: Buffer) => {
              console.log(`Socket write ${data.length} bytes`);
              this.socket.write(data, () => {
                console.log(`Socket write completed`);
              });
            }
          };

          resolve(Subject.create(socketObserver, socketObservable));
        } else {
          reject('Unauthorized connection');
        }
      });
    });
  }

}