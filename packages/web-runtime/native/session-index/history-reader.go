package main

import (
	"context"
	"os"
)

// 每个文件读取使用自己的取消上下文，不关闭其他请求共用的索引进程。
type historyReader struct {
	*os.File
	ctx context.Context
}

func (r *historyReader) ReadAt(buffer []byte, offset int64) (int, error) {
	total := 0
	for len(buffer) > 0 {
		if err := r.ctx.Err(); err != nil {
			return total, err
		}
		count, err := r.File.ReadAt(buffer[:min(len(buffer), int(historyWindowBytes))], offset+int64(total))
		total += count
		buffer = buffer[count:]
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func cancelledHistoryRead() *indexError {
	return &indexError{Message: "历史读取已取消", Code: "request_cancelled"}
}
