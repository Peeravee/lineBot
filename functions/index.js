/* eslint-disable prefer-const */
/* eslint-disable max-len */
/* eslint-disable camelcase */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const request = require("request-promise");
const path = require("path");
const wavedraw = require("wavedraw");
const toWav = require("audiobuffer-to-wav");
const AudioContext = require("web-audio-api").AudioContext;
const audioContext = new AudioContext();
const fs = require("fs");
const tf = require("@tensorflow/tfjs");
const tfnode = require("@tensorflow/tfjs-node");
const { v4: uuidv4 } = require("uuid");
const os = require("os");

admin.initializeApp();
const runtimeOpts = {
  timeoutSeconds: 180,
  memory: "1GB",
};

const token = `Ow/nDECGrRMCiyAWAeci3Nh16bC/ZibMNI3cuxkQGJWfzZ8o7xDao7AnRX7dml0912eXbqsU/blXQTGPOl2qthjRMlMcb96CUrocoL5trIWk99DCDK6EPyDgaKbG86oEuWFV8Y8qiYdM+J7rzw6R2AdB04t89/1O/w1cDnyilFU=
`;
const LINE_MESSAGING_API = "https://api.line.me/v2/bot/message/reply";
const LINE_HEADER = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};
const LINE_CONTENT_API_PRE = "https://api-data.line.me/v2/bot/message/";
const LINE_CONTENT_API_SUF = "/content";
const LINE_HEADER_AUDIO = {
  Authorization: `Bearer ${token}`,
};

exports.LineBotReply = functions
  .runWith(runtimeOpts)
  .https.onRequest(async (req, res) => {
    var event = req.body.events[0];
    var replyToken = event.replyToken;
    var messageId = req.body.events[0].message.id;
    var sendfrom = req.body.destination;
    if (req.body.events[0].message.type === "audio") {
      console.log("Is Audio");
      const contentBuffer = await getContent(messageId);
      const timestamp = req.body.events[0].timestamp;
      const filename = `${timestamp}.m4a`;
      const tempLocalFile = path.join(os.tmpdir(), filename);
      await fs.writeFileSync(tempLocalFile, contentBuffer);
      console.log("m4a writed!!");
      const filenamewav = `${timestamp}.wav`;
      const tempLocalFileWav = path.join(os.tmpdir(), filenamewav);
      const resp = await fs.readFileSync(tempLocalFile);
      console.log("read m4a!!!!");
      await audioContext.decodeAudioData(resp, async (buffer) => {
        const wav = toWav(buffer);
        await fs.writeFileSync(tempLocalFileWav, new Buffer.from(wav));
        await console.log("write wav");
        await waveDraw(tempLocalFileWav, timestamp);
        await console.log("draw wav");
        const pathImg = path.join(os.tmpdir(), `wave${timestamp}.png`);
        const urlImg = await uploadImage(event, pathImg, timestamp + ".png");
        await console.log("upload wav");
        const pred = await predict(pathImg);
        await clearTemp(filenamewav, filename, `wave${timestamp}.png`);
        await increaseTransaction(pred[0].className);
        await logPush(pred[0].className, pred[0].probability, sendfrom, urlImg);
        await reply(replyToken, pred[0].className, pred[0].probability, urlImg);
        return await res.status(200).end();
      });

      const db = admin.database();
      await db.ref("/prediction/All").transaction((current_val) => {
        return (current_val || 0) + 1;
      });
    }
  });

async function waveDraw(fpath, filename) {
  // eslint-disable-next-line new-cap
  const wd = new wavedraw(fpath);
  const filepath = path.join(os.tmpdir(), `wave${filename}.png`);
  const options = {
    width: 300,
    height: 300,
    rms: true,
    maximums: true,
    average: false,
    start: "START",
    end: "END",
    colors: {
      maximums: "#0000ff",
      rms: "#659df7",
      background: "#424242",
    },
    filename: filepath,
  };
  return await wd.drawWave(options);
}

async function clearTemp(wav, m4a, png) {
  await fs.unlinkSync(path.join(os.tmpdir(), wav));
  await fs.unlinkSync(path.join(os.tmpdir(), m4a));
  await fs.unlinkSync(path.join(os.tmpdir(), png));
  return console.log("Delete Temp Done");
}

async function predict(img) {
  const label = ["Bad", "Enemy", "Good", "Mite", "Pollen", "Queen"];
  const handler = tfnode.io.fileSystem("./model/model.json");
  const model = await tf.loadGraphModel(handler);
  await console.log("model is loaded!!!");
  const imgData = fs.readFileSync(img, Uint8Array);
  const tensor = await tfnode.node
    .decodePng(imgData, 3)
    .cast("float32")
    .resizeNearestNeighbor([300, 300])
    .expandDims()
    .toFloat();
  const pred = await model.predict(tensor).data();

  const predict = Array.from(pred)
    .map(function (p, i) {
      // this is Array.map
      return {
        probability: p,
        className: label[i], // we are selecting the value from the obj
      };
    })
    .sort(function (a, b) {
      return b.probability - a.probability;
    })
    .slice(0, 6);
  console.log(predict);
  return predict;
}

async function getContent(messageId) {
  const LINE_CONTENT_API =
    LINE_CONTENT_API_PRE + messageId + LINE_CONTENT_API_SUF;
  const contentBuffer = await request(LINE_CONTENT_API, {
    method: "GET",
    headers: LINE_HEADER_AUDIO,
    encoding: null,
  });

  return contentBuffer;
}

const classNameToTh = (className) => {
  let classNameth = "";
  switch (className) {
    case "Bad":
      classNameth = "มีควันไฟ";
      return classNameth;
      break;
    case "Good":
      classNameth = "ปกติ";
      return classNameth;
      break;
    case "Mite":
      classNameth = "มีตัวไร";
      return classNameth;
      break;
    case "Pollen":
      classNameth = "ขาดเกสรอาหาร";
      return classNameth;
      break;
    case "Queen":
      classNameth = "นางพญาหาย";
      return classNameth;
      break;
    case "Enemy":
      classNameth = "มีศัตรู";
      return classNameth;
      break;
    default:
      return classNameth;
  }
};

const reply = async (replyToken, className, probability, urlImg) => {
  let classNameTh = await classNameToTh(className);
  const prob = (probability * 100).toFixed(2);
  return request({
    method: "POST",
    uri: LINE_MESSAGING_API,
    headers: LINE_HEADER,
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [
        // {
        //   type: "image",
        //   originalContentUrl: `${urlImg}`,
        //   previewImageUrl: `${urlImg}`,
        // },
        // {
        //   type: "text",
        //   text: `${classNameTh}`,
        // },

        {
          type: "flex",
          altText: "ผลวินิจฉัย",
          contents: {
            type: "bubble",
            hero: {
              type: "image",
              url: `${urlImg}`,
              size: "full",
              aspectRatio: "20:8",
              aspectMode: "cover",
            },
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ผลวินิจฉัย",
                  weight: "bold",
                  size: "xl",
                },
                {
                  type: "text",
                  text: `${classNameTh} :  ${prob} %`,
                  size: "lg",
                },
              ],
            },
            footer: {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                {
                  type: "button",
                  style: "link",
                  height: "sm",
                  action: {
                    type: "uri",
                    uri: "https://linecorp.com",
                    label: "คำแนะนำ",
                  },
                },
                {
                  type: "box",
                  layout: "vertical",
                  contents: [],
                  margin: "sm",
                },
              ],
              flex: 0,
            },
          },
        },
      ],
    }),
  });
};

async function increaseTransaction(classname) {
  const db = admin.database();
  await db.ref("/prediction/All").transaction((current_val) => {
    return (current_val || 0) + 1;
  });
  await db.ref(`/prediction/${classname}`).transaction((current_val) => {
    return (current_val || 0) + 1;
  });
}

async function logPush(className, probability, sendfrom, urlImg) {
  const db = admin.database();
  await db.ref("/log").push({
    class: className,
    date: new Date().toLocaleString("en-GB", {
      timeZone: "Asia/Jakarta",
    }),
    probability: probability.toFixed(2),
    sendfrom: sendfrom,
    img: urlImg,
  });
}

async function uploadImage(event, imgLocalFile, filename) {
  const uuid = uuidv4();
  const bucket = admin.storage().bucket();
  const file = await bucket.upload(imgLocalFile, {
    // กำหนด path ในการเก็บไฟล์แยกเป็นแต่ละ userId
    destination: `photos/${event.source.userId}/${filename}`,
    metadata: {
      cacheControl: "no-cache",
      metadata: {
        firebaseStorageDownloadTokens: uuid,
      },
    },
  });
  const prefix = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o`;
  const suffix = `alt=media&token=${uuid}`;

  // ส่งคืนค่า public url ของรูปออกไป
  return `${prefix}/${encodeURIComponent(file[0].name)}?${suffix}`;
}
