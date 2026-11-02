package handler_test

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

// TestEventsPushRecentJobs 校验 SSE 用查询参数令牌可连，并能推送最近任务。
// 回归点：since 必须用 UTC，否则 SQLite 里按 UTC 存的时间与本地时区字符串比较会漏事件。
func TestEventsPushRecentJobs(t *testing.T) {
	e := newEnv(t)
	s := register(t, e, "sse@example.com", "SSE Lab")
	var ws model.Workspace
	if err := e.db.First(&ws, "id = ?", s.WSID).Error; err != nil {
		t.Fatalf("workspace: %v", err)
	}
	project := model.Project{WorkspaceID: ws.ID, Name: "P", Slug: "p", Platform: "amazon"}
	e.db.Create(&project)
	sku := model.SKU{WorkspaceID: ws.ID, ProjectID: project.ID, Code: "SSE-1"}
	e.db.Create(&sku)
	job := model.GenerationJob{
		WorkspaceID: ws.ID, SKUID: sku.ID, Template: "main",
		Status: "succeeded", ReviewStatus: "pending", Progress: 100,
	}
	job.ID = uuid.New()
	if err := e.db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	// 把更新时间挪到 30 秒前：仍在 2 分钟快照窗口内，能验证时间比较方向。
	if err := e.db.Model(&model.GenerationJob{}).Where("id = ?", job.ID).
		UpdateColumn("updated_at", time.Now().UTC().Add(-30*time.Second)).Error; err != nil {
		t.Fatalf("shift updated_at: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/v1/w/%s/events?access_token=%s", e.srv.URL, s.Slug, s.Access), nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("sse connect: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sse status %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}

	lines := make(chan string, 32)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("no job event within timeout")
		case line, ok := <-lines:
			if !ok {
				t.Fatal("stream closed before job event")
			}
			if line == "event: job" {
				return
			}
		}
	}
}
