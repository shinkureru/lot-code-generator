import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db, loginAnonymously } from "./firebase/firebase";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NUMBER_LIMIT = 100000;
const MAX_LOT_COUNT = LETTERS.length * NUMBER_LIMIT;
const LOT_COLLECTION_NAME = "lotRecords";

function App() {
  const [generateCount, setGenerateCount] = useState(10);
  const [lotList, setLotList] = useState([]);
  const [generatedCount, setGeneratedCount] = useState(0);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);

  const remainingCount = MAX_LOT_COUNT - generatedCount;

  const today = useMemo(() => {
    return new Date();
  }, []);

  const createdDate = useMemo(() => {
    return formatDate(today);
  }, [today]);

  const expiryDate = useMemo(() => {
    const date = new Date(today);
    date.setMonth(date.getMonth() + 15);

    return formatDate(date);
  }, [today]);

  useEffect(() => {
    async function initApp() {
      try {
        const user = auth.currentUser || (await loginAnonymously());

        setCurrentUser(user);

        await loadGeneratedCount();

        setMessage("已連線到 Firebase，多人共用資料庫已啟用。");
      } catch (error) {
        console.error(error);
        setMessage(
          "Firebase 連線失敗，請檢查 .env、匿名登入、Firestore Rules。",
        );
      } finally {
        setIsLoading(false);
      }
    }

    initApp();
  }, []);

  function formatNumber(number) {
    return number.toLocaleString("zh-TW");
  }

  function padTwoDigits(number) {
    return String(number).padStart(2, "0");
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = padTwoDigits(date.getMonth() + 1);
    const day = padTwoDigits(date.getDate());

    return `${year}-${month}-${day}`;
  }

  function formatDateTimeForFileName(date) {
    const year = date.getFullYear();
    const month = padTwoDigits(date.getMonth() + 1);
    const day = padTwoDigits(date.getDate());
    const hour = padTwoDigits(date.getHours());
    const minute = padTwoDigits(date.getMinutes());
    const second = padTwoDigits(date.getSeconds());

    return `${year}${month}${day}-${hour}${minute}${second}`;
  }

  function generateSingleLot() {
    const letterIndex = Math.floor(Math.random() * LETTERS.length);
    const randomLetter = LETTERS[letterIndex];

    const randomNumber = Math.floor(Math.random() * NUMBER_LIMIT)
      .toString()
      .padStart(5, "0");

    return `${randomLetter}${randomNumber}`;
  }

  async function loadGeneratedCount() {
    const lotCollectionRef = collection(db, LOT_COLLECTION_NAME);
    const snapshot = await getCountFromServer(lotCollectionRef);

    setGeneratedCount(snapshot.data().count);
  }

  async function createLotIfNotExists(lotCode) {
    const lotRef = doc(db, LOT_COLLECTION_NAME, lotCode);

    const newLot = {
      code: lotCode,
      createdAt: createdDate,
      expiryDate,
      note: `使用期限至 ${expiryDate}`,
      createdBy: currentUser.uid,
      createdAtServer: serverTimestamp(),
    };

    const createdLot = await runTransaction(db, async (transaction) => {
      const lotDoc = await transaction.get(lotRef);

      if (lotDoc.exists()) {
        return null;
      }

      transaction.set(lotRef, newLot);

      return newLot;
    });

    return createdLot;
  }

  async function handleGenerateLots() {
    if (!currentUser) {
      setMessage("尚未完成 Firebase 匿名登入，請稍後再試。");
      return;
    }

    if (remainingCount <= 0) {
      setMessage("所有 Lot 編號都已經產生完畢，已達上限。");
      return;
    }

    if (generateCount > remainingCount) {
      setMessage(
        `剩餘數量不足，目前只剩 ${formatNumber(remainingCount)} 組可以產生。`,
      );
      return;
    }

    setIsGenerating(true);
    setMessage("正在產生 Lot，並寫入 Firebase...");

    try {
      const newLots = [];
      let tryCount = 0;
      const maxTryCount = generateCount * 20;

      while (newLots.length < generateCount && tryCount < maxTryCount) {
        tryCount += 1;

        const newLotCode = generateSingleLot();
        const createdLot = await createLotIfNotExists(newLotCode);

        if (createdLot) {
          newLots.push(createdLot);
        }
      }

      if (newLots.length === 0) {
        setMessage("這次沒有成功產生新的 Lot，請再試一次。");
        return;
      }

      setLotList(newLots);
      await loadGeneratedCount();

      setMessage(
        `成功產生 ${newLots.length} 組 Lot 編號，使用期限至 ${expiryDate}。`,
      );
    } catch (error) {
      console.error(error);
      setMessage(
        "產生失敗：寫入 Firebase 時發生錯誤，請打開 Console 看錯誤訊息。",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopyLots() {
    if (lotList.length === 0) {
      setMessage("目前沒有可以複製的 Lot 編號。");
      return;
    }

    const copyText = lotList
      .map((lot) => `${lot.code}，${lot.note}`)
      .join("\n");

    try {
      await navigator.clipboard.writeText(copyText);
      setMessage("已成功複製本次產生結果。");
    } catch {
      setMessage("複製失敗，請確認瀏覽器是否允許剪貼簿功能。");
    }
  }

  async function handleExportJson() {
    try {
      const lotCollectionRef = collection(db, LOT_COLLECTION_NAME);
      const q = query(
        lotCollectionRef,
        orderBy("createdAtServer", "desc"),
        limit(1000),
      );

      const querySnapshot = await getDocs(q);

      const records = querySnapshot.docs.map((docSnapshot) => {
        const data = docSnapshot.data();

        return {
          code: data.code,
          createdAt: data.createdAt,
          expiryDate: data.expiryDate,
          note: data.note,
          createdBy: data.createdBy,
        };
      });

      if (records.length === 0) {
        setMessage("目前沒有任何 Lot 紀錄可以匯出。");
        return;
      }

      const now = new Date();
      const fileTime = formatDateTimeForFileName(now);

      const exportData = {
        title: "Lot 編號產生紀錄",
        exportedAt: now.toISOString(),
        format: "1 個英文字母 + 5 個數字",
        maxCount: MAX_LOT_COUNT,
        generatedCount,
        remainingCount,
        exportLimit: 1000,
        records,
      };

      const jsonString = JSON.stringify(exportData, null, 2);

      const blob = new Blob([jsonString], {
        type: "application/json",
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = `lot-records-${fileTime}.json`;
      link.click();

      URL.revokeObjectURL(url);

      setMessage(`已匯出最近 ${records.length} 筆 Lot 紀錄。`);
    } catch (error) {
      console.error(error);
      setMessage("匯出失敗：讀取 Firebase 資料時發生錯誤。");
    }
  }

  return (
    <main className="min-vh-100 bg-light py-5">
      <div className="container">
        <section className="mb-4 text-center">
          <span className="badge text-bg-primary mb-3">Lot Generator</span>

          <h1 className="fw-bold mb-3">這裡預留主標題</h1>

          <p className="text-secondary mb-0">
            產生格式為「1 個英文字母 + 5 個數字」的不重複 Lot
            編號，資料會同步寫入 Firebase。
          </p>
        </section>

        <section className="row g-4 mb-4">
          <div className="col-12 col-md-4">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <p className="text-secondary mb-1">Lot 編號總上限</p>
                <h3 className="fw-bold mb-0">{formatNumber(MAX_LOT_COUNT)}</h3>
              </div>
            </div>
          </div>

          <div className="col-12 col-md-4">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <p className="text-secondary mb-1">Firebase 已產生</p>
                <h3 className="fw-bold mb-0">{formatNumber(generatedCount)}</h3>
              </div>
            </div>
          </div>

          <div className="col-12 col-md-4">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <p className="text-secondary mb-1">剩餘可產生</p>
                <h3 className="fw-bold mb-0">{formatNumber(remainingCount)}</h3>
              </div>
            </div>
          </div>
        </section>

        <section className="card border-0 shadow-sm mb-4">
          <div className="card-body p-4">
            <div className="row g-3 align-items-end">
              <div className="col-12 col-md-4">
                <label
                  htmlFor="generateCount"
                  className="form-label fw-semibold"
                >
                  選擇一次產生數量
                </label>

                <select
                  id="generateCount"
                  className="form-select"
                  value={generateCount}
                  disabled={isLoading || isGenerating}
                  onChange={(event) =>
                    setGenerateCount(Number(event.target.value))
                  }
                >
                  <option value="10">10 個</option>
                  <option value="30">30 個</option>
                  <option value="50">50 個</option>
                </select>
              </div>

              <div className="col-12 col-md-8">
                <div className="d-flex flex-column flex-md-row gap-2 justify-content-md-end">
                  <button
                    type="button"
                    className="btn btn-primary px-4"
                    disabled={isLoading || isGenerating}
                    onClick={handleGenerateLots}
                  >
                    {isGenerating ? "產生中..." : "產生 Lot"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-outline-secondary px-4"
                    disabled={isLoading || isGenerating}
                    onClick={handleCopyLots}
                  >
                    一鍵複製本次結果
                  </button>

                  <button
                    type="button"
                    className="btn btn-outline-success px-4"
                    disabled={isLoading || isGenerating}
                    onClick={handleExportJson}
                  >
                    匯出 JSON
                  </button>
                </div>
              </div>
            </div>

            {message && (
              <div className="alert alert-info mt-4 mb-0" role="alert">
                {message}
              </div>
            )}
          </div>
        </section>

        <section className="card border-0 shadow-sm">
          <div className="card-header bg-white py-3">
            <div className="d-flex flex-column flex-md-row justify-content-between gap-2">
              <h2 className="h5 fw-bold mb-0">本次產生結果</h2>
              <span className="text-secondary">本次使用期限：{expiryDate}</span>
            </div>
          </div>

          <div className="card-body p-0">
            {lotList.length === 0 ? (
              <div className="p-4 text-center text-secondary">
                尚未產生新的 Lot 編號。
              </div>
            ) : (
              <div className="table-responsive">
                <table className="table table-hover align-middle mb-0">
                  <thead className="table-light">
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Lot 編號</th>
                      <th scope="col">產生日期</th>
                      <th scope="col">有效期限</th>
                      <th scope="col">備註</th>
                    </tr>
                  </thead>

                  <tbody>
                    {lotList.map((lot, index) => (
                      <tr key={lot.code}>
                        <td>{index + 1}</td>
                        <td className="fw-semibold font-monospace">
                          {lot.code}
                        </td>
                        <td>{lot.createdAt}</td>
                        <td>{lot.expiryDate}</td>
                        <td>{lot.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
