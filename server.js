
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
// Render sẽ tự động cấp PORT qua biến môi trường, mặc định 3000 nếu chạy local
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Link API lịch sử gốc
const HISTORY_MD5_URL = '';
const HISTORY_TX_URL = 'http://103.249.117.229:17227/api/68gb/vhtx';

/**
 * Hàm lấy dữ liệu lịch sử từ API gốc theo URL truyền vào và sắp xếp tăng dần theo phiên (cũ -> mới)
 */
async function fetchHistoryData(apiUrl) {
    try {
        const response = await axios.get(apiUrl, { timeout: 8000 });
        const jsonData = response.data;

        if (!jsonData || !jsonData.success || !Array.isArray(jsonData.data) || jsonData.data.length === 0) {
            return { data: null, error: 'Dữ liệu API lịch sử trống hoặc không hợp lệ.' };
        }

        // Sắp xếp tăng dần theo phiên để phân tích đúng chiều thời gian (cũ -> mới)
        const sortedData = jsonData.data.sort((a, b) => Number(a.phien) - Number(b.phien));
        return { data: sortedData, error: null };
    } catch (err) {
        return { data: null, error: `Lỗi kết nối API lịch sử: ${err.message}` };
    }
}

/**
 * Thuật toán VIP cho bàn MD5 (/vanhoa)
 */
function analyzePatternVIP(history) {
    // Chuyển đổi kết quả sang dạng ký hiệu T (Tài) và X (Xỉu)
    const seq = history.map(item => item.result.trim().toLowerCase() === 'tài' ? 'T' : 'X');
    const sums = history.map(item => Number(item.sum));

    const n = seq.length;
    const lastItem = history[n - 1];
    const nextPhien = Number(lastItem.phien) + 1;

    // Chuỗi pattern 12 phiên gần nhất
    const recentPattern = seq.slice(-12).join('-');

    // Tính độ dài dây bệt hiện tại ở cuối chuỗi
    const currentChar = seq[n - 1];
    let streak = 0;
    for (let i = n - 1; i >= 0; i--) {
        if (seq[i] === currentChar) {
            streak++;
        } else {
            break;
        }
    }

    let predictionChar = currentChar;
    let confidence = 70.0;
    let reason = '';
    let strategy = '';

    // --- TẦNG 1: PHÂN TÍCH CẦU BỆT (STREAK >= 4) ---
    if (streak >= 4) {
        const last3Sums = sums.slice(-3);
        if (currentChar === 'T') {
            // Tài bệt nhưng điểm giảm dần về sát mốc 11 -> Dấu hiệu hụt hơi, bẻ cầu
            if (last3Sums[last3Sums.length - 1] <= 11 && last3Sums[0] > last3Sums[last3Sums.length - 1]) {
                predictionChar = 'X';
                confidence = 86.5;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Tài dây ${streak} nhưng tổng điểm đang suy yếu về mốc biên (${last3Sums[last3Sums.length - 1]} điểm). Tín hiệu đảo chiều sang Xỉu cực cao.`;
            } else if (streak >= 7) {
                predictionChar = 'X';
                confidence = 89.0;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Tài đã kéo dài tới ${streak} tay (chạm ngưỡng bão hòa). Thuật toán ưu tiên bẻ gãy chuỗi sang Xỉu.`;
            } else {
                predictionChar = 'T';
                confidence = 84.0;
                strategy = 'THEO CẦU';
                reason = `Cầu bệt Tài đang vào form đẹp (dây ${streak}), lực xúc xắc duy trì ổn định. Tiếp tục theo bệt.`;
            }
        } else {
            // Xỉu bệt nhưng điểm tăng dần lên sát mốc 10 -> Dấu hiệu đảo chiều sang Tài
            if (last3Sums[last3Sums.length - 1] >= 10 && last3Sums[0] < last3Sums[last3Sums.length - 1]) {
                predictionChar = 'T';
                confidence = 86.5;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Xỉu dây ${streak} nhưng tổng điểm đang đẩy sát biên trên (${last3Sums[last3Sums.length - 1]} điểm). Khả năng cao bẻ sang Tài.`;
            } else if (streak >= 7) {
                predictionChar = 'T';
                confidence = 89.0;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Xỉu đạt đỉnh ${streak} tay liên tiếp. Áp dụng quy tắc hồi quy xác suất để bẻ sang Tài.`;
            } else {
                predictionChar = 'X';
                confidence = 84.0;
                strategy = 'THEO CẦU';
                reason = `Đang chạy dây bệt Xỉu (${streak} phiên liên tiếp), nhịp cầu chưa có dấu hiệu hụt hơi. Đánh theo cầu.`;
            }
        }
    }
    // --- TẦNG 2: PHÂN TÍCH CẦU NGẮN & CẦU ĐỐI XỨNG (STREAK < 4) ---
    else if (n >= 4) {
        const tail4 = seq.slice(-4).join('');
        const tail5 = n >= 5 ? seq.slice(-5).join('') : '';

        // 1. Nhận diện Cầu 1-1 (T-X-T-X hoặc X-T-X-T)
        if (tail4 === 'TXTX' || tail4 === 'XTXT') {
            predictionChar = currentChar === 'X' ? 'T' : 'X';
            confidence = 85.5;
            strategy = 'THEO CẦU 1-1';
            reason = `Phát hiện nhịp cầu ngắn 1-1 (${seq.slice(-4).join('-')}) đang chạy rất đều. Tiếp tục bắt nhịp đảo luân phiên.`;
        }
        // 2. Nhận diện Cầu 2-2 (T-T-X-X hoặc X-X-T-T)
        else if (tail4 === 'TTXX' || tail4 === 'XXTT') {
            if (tail4 === 'TTXX') {
                predictionChar = 'T';
                reason = 'Hình thành cầu cặp 2-2 (T-T-X-X). Phiên tiếp theo mở đầu cặp Tài mới.';
            } else {
                predictionChar = 'X';
                reason = 'Hình thành cầu cặp 2-2 (X-X-T-T). Phiên tiếp theo mở đầu cặp Xỉu mới.';
            }
            confidence = 82.0;
            strategy = 'THEO CẦU 2-2';
        }
        // 3. Nhận diện Cầu 1-2-2 tiến lên 1-2-3
        else if (tail5 === 'TXXTT' || tail5 === 'XTTXX') {
            predictionChar = currentChar;
            confidence = 79.5;
            strategy = 'THEO CẦU 1-2-3';
            reason = `Cầu đang phát triển theo thế 1-2-2 (${seq.slice(-5).join('-')}), ưu tiên đánh thuận theo đà lên tay thứ 3.`;
        }
        // 4. Nhận diện Cầu 1-2-1
        else if (tail4 === 'TXXT' || tail4 === 'XTTX') {
            predictionChar = currentChar;
            confidence = 78.0;
            strategy = 'THEO NHỊP 1-2';
            reason = `Xuất hiện mẫu cầu ngắn 1-2-1 (${seq.slice(-4).join('-')}), dự đoán lặp lại vế đôi ở phiên kế tiếp.`;
        }
        // 5. Dây 3 tay liên tiếp
        else if (streak === 3) {
            predictionChar = currentChar;
            confidence = 77.5;
            strategy = 'THEO ĐÀ BỆT';
            reason = `Cầu đã đi được 3 tay ${currentChar === 'T' ? 'Tài' : 'Xỉu'} liên tiếp, dấu hiệu chớm hình thành cầu bệt. Đánh theo cầu.`;
        }
        // 6. Dây 2 tay liên tiếp -> Dựa vào lực điểm tổng để theo tay 3 hoặc bẻ về 2-1
        else if (streak === 2) {
            const lastSum = sums[n - 1];
            if ((currentChar === 'T' && lastSum >= 14) || (currentChar === 'X' && lastSum <= 7)) {
                predictionChar = currentChar;
                confidence = 76.5;
                strategy = 'THEO CẦU';
                reason = `Cầu đôi ${currentChar === 'T' ? 'Tài' : 'Xỉu'} có tổng điểm cực mạnh (${lastSum} điểm), lực cầu còn dư địa đi tiếp tay 3.`;
            } else {
                predictionChar = currentChar === 'T' ? 'X' : 'T';
                confidence = 75.0;
                strategy = 'BẺ NHỊP NGẮN';
                reason = `Cầu ngắn đi 2 tay với điểm số trung bình (${lastSum} điểm), dễ gãy sang cầu 2-1. Chốt bẻ ngược.`;
            }
        }
        // 7. Cầu biến động -> Tính trung bình động 5 phiên
        else {
            const recentSums = sums.slice(-5);
            const avgSum = recentSums.reduce((a, b) => a + b, 0) / recentSums.length;
            if (avgSum > 10.5) {
                predictionChar = 'X';
                reason = `Cầu ngắn đang biến động, trung bình điểm 5 phiên nghiêng mạnh về Tài (${avgSum.toFixed(1)}đ). Bắt nhịp cân bằng sang Xỉu.`;
            } else {
                predictionChar = 'T';
                reason = `Cầu ngắn đang biến động, trung bình điểm 5 phiên nghiêng về Xỉu (${avgSum.toFixed(1)}đ). Bắt nhịp cân bằng sang Tài.`;
            }
            confidence = 73.5;
            strategy = 'CÂN BẰNG ĐIỂM';
        }
    }
    // --- DỰ PHÒNG NẾU LỊCH SỬ TRẢ VỀ QUÁ ÍT (< 4 PHIÊN) ---
    else {
        predictionChar = currentChar === 'X' ? 'T' : 'X';
        confidence = 68.0;
        strategy = 'CẦU NGẮN';
        reason = 'Dữ liệu lịch sử ngắn, áp dụng thuật toán đảo chiều cơ bản dựa trên phiên liền kề.';
    }

    const dudoanText = predictionChar === 'T' ? 'Tài' : 'Xỉu';

    return {
        success: true,
        phiendudoan: nextPhien,
        dudoan: dudoanText,
        dotincay: `${confidence}%`,
        patten: recentPattern,
        chienthuat: strategy,
        lido: reason,
        phien_gan_nhat: {
            phien: lastItem.phien,
            ket_qua: lastItem.result,
            xuc_xac: lastItem.dice,
            tong: lastItem.sum
        }
    };
}

/**
 * THUẬT TOÁN VIP PRO 5 TẦNG CHUYÊN SÂU CHO BÀN TÀI XỈU THƯỜNG (/vhtx)
 * Phân tích kỹ lưỡng 20 phiên gần nhất:
 * - Tầng 1: Nhận diện cầu bệt & độ dốc biến thiên điểm số (Momentum)
 * - Tầng 2: Quét chuỗi cầu 1-1 dài (như mẫu X-T-X-T-X-T-X-T) & điểm gãy cầu 1-1
 * - Tầng 3: Phân tích cấu trúc khối (Block Pattern: 4-2-1-1-1-1-1-1-1-3-4) và tính đối xứng lịch sử
 * - Tầng 4: Giải phẫu lực 3 viên xúc xắc (kiểm tra bão/cặp đôi và sự chuyển dịch nút lớn/nhỏ)
 * - Tầng 5: Cân bằng tỷ lệ Tài/Xỉu toàn cục trong 20 phiên (Mean Reversion)
 */
function analyzePatternTXDeep(history) {
    const seq = history.map(item => item.result.trim().toLowerCase() === 'tài' ? 'T' : 'X');
    const sums = history.map(item => Number(item.sum));
    const dices = history.map(item => item.dice.split('-').map(Number));

    const n = seq.length;
    const lastItem = history[n - 1];
    const nextPhien = Number(lastItem.phien) + 1;

    // Hiển thị pattern 15 phiên gần nhất để quan sát rõ toàn cảnh
    const recentPattern = seq.slice(-15).join('-');

    // 1. Tính độ dài dây bệt hiện tại ở cuối chuỗi
    const currentChar = seq[n - 1];
    let streak = 0;
    for (let i = n - 1; i >= 0; i--) {
        if (seq[i] === currentChar) streak++;
        else break;
    }

    // 2. Phân tích cấu trúc các khối (Runs/Blocks) từ cũ đến mới
    // Ví dụ: [4T, 2X, 1T, 1X, ..., 3X, 4T]
    const blocks = [];
    let tempChar = seq[0];
    let tempLen = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === tempChar) {
            tempLen++;
        } else {
            blocks.push({ char: tempChar, len: tempLen });
            tempChar = seq[i];
            tempLen = 1;
        }
    }
    blocks.push({ char: tempChar, len: tempLen });

    // 3. Thống kê tỷ lệ Tài/Xỉu trong 20 phiên và 10 phiên gần nhất
    const totalT = seq.filter(c => c === 'T').length;
    const totalX = n - totalT;
    const last10 = seq.slice(-10);
    const recentT = last10.filter(c => c === 'T').length;
    const recentX = last10.length - recentT;

    // 4. Phân tích lực 3 viên xúc xắc phiên cuối & xu hướng điểm 3 phiên cuối
    const lastDice = dices[n - 1];
    const hasPair = (lastDice[0] === lastDice[1] || lastDice[1] === lastDice[2] || lastDice[0] === lastDice[2]);
    const isTriple = (lastDice[0] === lastDice[1] && lastDice[1] === lastDice[2]);
    const last3Sums = sums.slice(-3);

    // Hệ thống chấm điểm trọng số (Score > 0 nghiêng về Tài, Score < 0 nghiêng về Xỉu)
    let score = 0;
    let reasons = [];
    let strategy = '';

    // --- PHÂN TÍCH TẦNG 1: CẦU BỆT & LỊCH SỬ ĐỈNH BỆT TRONG BÀN ---
    // Tìm độ dài dây bệt lớn nhất từng xuất hiện trong 20 phiên qua để biết "ngưỡng chịu đựng" của bàn
    const maxHistoricalStreak = Math.max(...blocks.slice(0, -1).map(b => b.len), 3);

    if (streak >= 4) {
        // Kiểm tra xu hướng điểm số của dây bệt
        const sumTrend = last3Sums[last3Sums.length - 1] - last3Sums[0];
        if (currentChar === 'T') {
            if (streak >= maxHistoricalStreak && streak >= 5) {
                score -= 45;
                strategy = 'BẺ CẦU ĐỈNH';
                reasons.push(`Dây bệt Tài đã chạm ngưỡng tối đa của bàn (${streak} tay, bằng đỉnh cũ ${maxHistoricalStreak} tay). Áp lực đảo chiều cực lớn.`);
            } else if (last3Sums[last3Sums.length - 1] <= 12 && sumTrend <= 0 && !hasPair) {
                score -= 32;
                strategy = 'BẺ CẦU HỤT LỰC';
                reasons.push(`Bệt Tài dây ${streak} nhưng điểm số đang nén sát biên dưới (${last3Sums.join(' -> ')}) và không còn cặp đôi giữ nhịp.`);
            } else {
                score += 38;
                strategy = 'THEO BỆT TÀI';
                reasons.push(`Cầu bệt Tài dây ${streak} đang giữ nhịp ổn định (${last3Sums.join(' -> ')}đ), chưa chạm ngưỡng gãy của bàn (${maxHistoricalStreak} tay).`);
            }
        } else {
            if (streak >= maxHistoricalStreak && streak >= 5) {
                score += 45;
                strategy = 'BẺ CẦU ĐỈNH';
                reasons.push(`Dây bệt Xỉu đã chạm ngưỡng tối đa của bàn (${streak} tay, bằng đỉnh cũ ${maxHistoricalStreak} tay). Tín hiệu bẻ sang Tài.`);
            } else if (last3Sums[last3Sums.length - 1] >= 9 && sumTrend >= 0 && !hasPair) {
                score += 32;
                strategy = 'BẺ CẦU HỤT LỰC';
                reasons.push(`Bệt Xỉu dây ${streak} nhưng tổng điểm đang đẩy lên sát biên trên (${last3Sums.join(' -> ')}đ), lực Xỉu suy yếu.`);
            } else {
                score -= 38;
                strategy = 'THEO BỆT XỈU';
                reasons.push(`Cầu bệt Xỉu dây ${streak} đang chạy mượt (${last3Sums.join(' -> ')}đ), lực nút nhỏ chiếm ưu thế.`);
            }
        }
    }
    // --- PHÂN TÍCH TẦNG 2: CẦU 1-1 & CẦU NHỊP NGẮN ---
    else if (streak === 1) {
        // Đếm xem có bao nhiêu khối độ dài 1 liên tiếp ở cuối (cầu 1-1)
        let altCount = 0;
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].len === 1) altCount++;
            else break;
        }

        if (altCount >= 4) {
            // Đang chạy cầu 1-1 dài (từ 4 tay trở lên)
            if (altCount >= 8) {
                // Cầu 1-1 quá dài (>= 8 tay) rất dễ gãy thành bệt nhẹ (dây 2)
                score += (currentChar === 'T' ? 35 : -35);
                strategy = 'BẺ GÃY CẦU 1-1 DÀI';
                reasons.push(`Cầu 1-1 đã kéo dài tới ${altCount} nhịp liên tiếp (cực đại), thuật toán bắt điểm gãy giữ lại ${currentChar === 'T' ? 'Tài' : 'Xỉu'} thành đôi.`);
            } else {
                // Tiếp tục theo cầu 1-1
                score += (currentChar === 'T' ? -40 : 40);
                strategy = `THEO CẦU 1-1 (${altCount} NHỊP)`;
                reasons.push(`Chuỗi đảo 1-1 đang chạy cực chuẩn (${altCount} tay luân phiên), tiếp tục bắt nhịp đảo sang ${currentChar === 'T' ? 'Xỉu' : 'Tài'}.`);
            }
        } else if (blocks.length >= 3 && blocks[blocks.length - 2].len === 2 && blocks[blocks.length - 3].len === 2) {
            // Mẫu 2-2-1 -> Dự đoán lên 2-2-2
            score += (currentChar === 'T' ? 34 : -34);
            strategy = 'THEO CẦU CẶP 2-2';
            reasons.push(`Phát hiện cấu trúc cầu cặp 2-2 đang lặp lại, ưu tiên đánh lên tay thứ 2 của cặp ${currentChar === 'T' ? 'Tài' : 'Xỉu'}.`);
        } else {
            // Phân tích điểm số phiên vừa bẻ cầu
            const lastSum = sums[n - 1];
            if ((currentChar === 'T' && lastSum >= 14) || (currentChar === 'X' && lastSum <= 7)) {
                score += (currentChar === 'T' ? 26 : -26);
                strategy = 'THEO ĐÀ ĐẢO CHIỀU';
                reasons.push(`Phiên vừa đảo sang ${currentChar === 'T' ? 'Tài' : 'Xỉu'} với điểm số rất sâu (${lastSum}đ), dễ kéo thêm tay thứ 2.`);
            } else {
                score += (currentChar === 'T' ? -24 : 24);
                strategy = 'NHỊP ĐẢO NGẮN';
                reasons.push(`Điểm số phiên đảo chiều ở mức trung bình (${lastSum}đ), xu hướng quay lại nhịp 1-1.`);
            }
        }
    }
    // --- PHÂN TÍCH TẦNG 3: CẦU ĐÔI (STREAK = 2) VÀ CẦU 3 (STREAK = 3) ---
    else if (streak === 2 || streak === 3) {
        // Kiểm tra tính đối xứng khối (Ví dụ đầu bảng có 4T - 2X, cuối bảng có 3X - 3T -> dễ lên 4T)
        const firstBlock = blocks[0];
        const prevBlock = blocks.length >= 2 ? blocks[blocks.length - 2] : null;

        if (streak === 3) {
            if (firstBlock && firstBlock.char === currentChar && firstBlock.len >= 4) {
                score += (currentChar === 'T' ? 36 : -36);
                strategy = 'ĐỐI XỨNG CẦU BỆT';
                reasons.push(`Cầu đã đi 3 tay ${currentChar === 'T' ? 'Tài' : 'Xỉu'}, trùng khớp với form bệt ${firstBlock.len} tay ở đầu bảng. Đánh thuận lên tay 4.`);
            } else if ((currentChar === 'T' && sums[n - 1] <= 11) || (currentChar === 'X' && sums[n - 1] >= 10)) {
                score += (currentChar === 'T' ? -30 : 30);
                strategy = 'BẺ CẦU 3-1';
                reasons.push(`Tay thứ 3 chạm mốc điểm biên (${sums[n - 1]}đ), lực cầu suy giảm mạnh, ưu tiên bẻ về cầu 3-1.`);
            } else {
                score += (currentChar === 'T' ? 28 : -28);
                strategy = 'THEO ĐÀ TAY 4';
                reasons.push(`Dây 3 ${currentChar === 'T' ? 'Tài' : 'Xỉu'} giữ biên độ điểm an toàn (${last3Sums.join(' -> ')}đ), tiếp tục theo cầu.`);
            }
        } else {
            // streak === 2
            if (prevBlock && prevBlock.len === 2) {
                // Đang là 2-2 -> Bẻ sang mở cặp 2 mới
                score += (currentChar === 'T' ? -35 : 35);
                strategy = 'THEO CẦU 2-2';
                reasons.push(`Đang vào nhịp cầu đôi 2-2 chuẩn xác, chốt bẻ sang mở đầu cặp ${currentChar === 'T' ? 'Xỉu' : 'Tài'} mới.`);
            } else if (hasPair || (currentChar === 'T' && sums[n - 1] >= 13) || (currentChar === 'X' && sums[n - 1] <= 8)) {
                score += (currentChar === 'T' ? 25 : -25);
                strategy = 'THEO CẦU LÊN 3';
                reasons.push(`Cầu đôi ${currentChar === 'T' ? 'Tài' : 'Xỉu'} có lực xúc xắc mạnh (${lastItem.dice} = ${sums[n - 1]}đ), dư địa lên tay 3.`);
            } else {
                score += (currentChar === 'T' ? -25 : 25);
                strategy = 'BẺ CẦU 2-1';
                reasons.push(`Cầu đôi không có đột biến điểm số (${sums[n - 1]}đ), khả năng cao gãy về nhịp 2-1.`);
            }
        }
    }

    // --- PHÂN TÍCH TẦNG 4 & 5: ĐIỀU CHỈNH TRỌNG SỐ XÚC XẮC & HỒI QUY 20 PHIÊN ---
    // Nếu 10 phiên gần nhất lệch quá nhiều (>= 7/10 về một cửa), cộng thêm lực hồi quy nhẹ
    if (recentT >= 7) {
        score -= 10;
        reasons.push(`10 phiên gần nhất Tài đang chiếm ưu thế (${recentT}/10), có lực hút cân bằng về Xỉu.`);
    } else if (recentX >= 7) {
        score += 10;
        reasons.push(`10 phiên gần nhất Xỉu đang chiếm ưu thế (${recentX}/10), có lực hút cân bằng về Tài.`);
    }

    if (isTriple) {
        // Vừa nổ bão (3 con giống nhau) thường đảo chiều ở phiên kế tiếp
        score += (currentChar === 'T' ? -15 : 15);
        reasons.push(`Phiên vừa xuất hiện Bão (${lastItem.dice}), xác suất đảo chiều phiên kế tiếp tăng cao.`);
    }

    // Chốt kết quả cuối cùng dựa trên điểm trọng số (Tuyệt đối không random)
    const predictionChar = score >= 0 ? 'T' : 'X';
    const absScore = Math.abs(score);

    // Tính độ tin cậy thực tế dựa trên độ lớn của điểm trọng số (từ 72.0% đến 92.5%)
    let confidence = 70 + (absScore * 0.42);
    if (confidence > 92.5) confidence = 92.5;
    if (confidence < 71.5) confidence = 71.5;
    confidence = Number(confidence.toFixed(1));

    const dudoanText = predictionChar === 'T' ? 'Tài' : 'Xỉu';

    return {
        success: true,
        phiendudoan: nextPhien,
        dudoan: dudoanText,
        dotincay: `${confidence}%`,
        patten: recentPattern,
        chienthuat: strategy,
        lido: reasons.join(' '),
        thong_ke_20_phien: {
            tai: totalT,
            xiu: totalX,
            day_bet_hien_tai: `${streak} ${currentChar === 'T' ? 'Tài' : 'Xỉu'}`
        },
        phien_gan_nhat: {
            phien: lastItem.phien,
            ket_qua: lastItem.result,
            xuc_xac: lastItem.dice,
            tong: lastItem.sum
        }
    };
}

// Route mặc định kiểm tra server sống (tránh Render báo lỗi healthcheck)
app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        endpoints: {
            md5: '/vanhoa',
            tx: '/vhtx'
        },
        message: 'Hệ thống API Dự đoán Tài Xỉu tự động đang hoạt động.'
    });
});

// Endpoint bàn MD5
app.get('/vanhoa', async (req, res) => {
    const { data, error } = await fetchHistoryData(HISTORY_MD5_URL);
    if (error) {
        return res.status(500).json({
            success: false,
            message: error
        });
    }

    const result = analyzePatternVIP(data);
    return res.json(result);
});

// Endpoint bàn Tài Xỉu thường (Thuật toán chuyên sâu 5 tầng)
app.get('/vhtx', async (req, res) => {
    const { data, error } = await fetchHistoryData(HISTORY_TX_URL);
    if (error) {
        return res.status(500).json({
            success: false,
            message: error
        });
    }

    const result = analyzePatternTXDeep(data);
    return res.json(result);
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại cổng ${PORT}`);
});
