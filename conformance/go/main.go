package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/actions/scaleset"
)

const adminToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjE4OTM0NTYwMDB9.signature"

type response struct {
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
}

type scenario struct {
	Name             string          `json:"name"`
	Operation        string          `json:"operation"`
	Input            json.RawMessage `json:"input,omitempty"`
	ActionsResponses []response      `json:"actionsResponses,omitempty"`
	QueueResponses   []response      `json:"queueResponses,omitempty"`
}

type requestTrace struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`
}

type errorTrace struct {
	Code string `json:"code"`
}

type transcript struct {
	Requests []requestTrace `json:"requests"`
	Result   any            `json:"result,omitempty"`
	Error    *errorTrace    `json:"error,omitempty"`
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: conformance-reference <scenario.json>")
	}
	var input scenario
	contents, err := os.ReadFile(os.Args[1])
	must(err)
	must(json.Unmarshal(contents, &input))

	output := transcript{Requests: []requestTrace{}}
	actionIndex := 0
	queueIndex := 0
	var responseMu sync.Mutex
	var concurrentQueueArrivals atomic.Int32
	var concurrentQueueBarrier chan struct{}
	if input.Operation == "getMessageConcurrentRefresh" {
		concurrentQueueBarrier = make(chan struct{})
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		must(err)
		isQueueRequest := strings.HasPrefix(r.URL.Path, "/queue")
		queueResponseIndex := -1
		var serverResponse response

		responseMu.Lock()
		output.Requests = append(output.Requests, requestTrace{
			Method:  r.Method,
			Path:    r.URL.Path,
			Query:   r.URL.RawQuery,
			Body:    canonicalBody(strings.ReplaceAll(string(body), server.URL+"/acme", "<config-url>")),
			Headers: selectedHeaders(r),
		})
		switch {
		case strings.HasSuffix(r.URL.Path, "/registration-token"):
			serverResponse = response{Status: http.StatusCreated, Body: json.RawMessage(`{"token":"registration"}`)}
		case strings.HasSuffix(r.URL.Path, "/actions/runner-registration"):
			serverResponse = response{Status: http.StatusCreated, Body: json.RawMessage(fmt.Sprintf(`{"url":%q,"token":%q}`, server.URL+"/tenant/", adminToken))}
		case isQueueRequest:
			queueResponseIndex = queueIndex
			serverResponse = next(input.QueueResponses, &queueIndex)
		default:
			serverResponse = withQueueURL(next(input.ActionsResponses, &actionIndex), server.URL)
		}
		responseMu.Unlock()

		if concurrentQueueBarrier != nil {
			if isQueueRequest && queueResponseIndex < 2 && concurrentQueueArrivals.Add(1) == 2 {
				close(concurrentQueueBarrier)
			}
			if r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/sessions/") {
				<-concurrentQueueBarrier
			}
		}
		writeJSON(w, serverResponse)
	}))
	defer server.Close()

	if input.Operation == "constructorValidation" {
		_, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
			GitHubConfigURL:     server.URL + "/acme",
			PersonalAccessToken: "",
		})
		if err != nil {
			output.Error = &errorTrace{Code: errorCode(err)}
		} else {
			output.Result = "constructed"
		}
		encoded, err := json.Marshal(output)
		must(err)
		fmt.Println(string(encoded))
		return
	}

	client, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
		GitHubConfigURL:     server.URL + "/acme",
		PersonalAccessToken: "reference-pat",
		SystemInfo:          scaleset.SystemInfo{System: "reference", Version: "main@cb0405b", Subsystem: "conformance"},
	})
	must(err)
	output.Result, err = run(context.Background(), client, input)
	output.Result = normalizeResult(output.Result)
	if err != nil {
		output.Error = &errorTrace{Code: errorCode(err)}
		output.Result = nil
	}
	if input.Operation == "getMessageConcurrentRefresh" {
		sort.Slice(output.Requests, func(i, j int) bool {
			return requestTraceKey(output.Requests[i]) < requestTraceKey(output.Requests[j])
		})
	}
	encoded, err := json.Marshal(output)
	must(err)
	fmt.Println(string(encoded))
}

func run(ctx context.Context, client *scaleset.Client, input scenario) (any, error) {
	var value map[string]any
	if len(input.Input) > 0 {
		if err := json.Unmarshal(input.Input, &value); err != nil {
			return nil, err
		}
	}
	integer := func(name string) int { return int(value[name].(float64)) }
	text := func(name string) string { return value[name].(string) }
	switch input.Operation {
	case "getRunner":
		return client.GetRunner(ctx, integer("id"))
	case "getRunnerByName":
		return client.GetRunnerByName(ctx, text("name"))
	case "removeRunner":
		return nil, client.RemoveRunner(ctx, int64(integer("id")))
	case "getRunnerGroupByName":
		return client.GetRunnerGroupByName(ctx, text("name"))
	case "getRunnerScaleSet":
		return client.GetRunnerScaleSet(ctx, integer("runnerGroupId"), text("name"))
	case "listRunnerScaleSets":
		return client.ListRunnerScaleSets(ctx, integer("runnerGroupId"))
	case "getRunnerScaleSetByID":
		return client.GetRunnerScaleSetByID(ctx, integer("id"))
	case "createRunnerScaleSet":
		return client.CreateRunnerScaleSet(ctx, &scaleset.RunnerScaleSet{Name: text("name")})
	case "updateRunnerScaleSet":
		return client.UpdateRunnerScaleSet(ctx, integer("id"), &scaleset.RunnerScaleSet{Name: text("name")})
	case "deleteRunnerScaleSet":
		return nil, client.DeleteRunnerScaleSet(ctx, integer("id"))
	case "generateJitRunnerConfig":
		return client.GenerateJitRunnerConfig(ctx, &scaleset.RunnerScaleSetJitRunnerSetting{Name: text("name"), WorkFolder: text("workFolder")}, integer("scaleSetId"))
	case "createMessageSession":
		session, err := client.MessageSessionClient(ctx, integer("scaleSetId"), text("owner"))
		if err != nil {
			return nil, err
		}
		current := session.Session()
		return map[string]any{"sessionId": current.SessionID.String(), "ownerName": current.OwnerName}, nil
	case "getMessage", "getMessageRefresh":
		session, err := client.MessageSessionClient(ctx, integer("scaleSetId"), text("owner"))
		if err != nil {
			return nil, err
		}
		message, err := session.GetMessage(ctx, integer("lastMessageId"), integer("maxCapacity"))
		if err != nil || message == nil {
			return nil, err
		}
		return messageTrace(message), nil
	case "getMessageConcurrentRefresh":
		session, err := client.MessageSessionClient(ctx, integer("scaleSetId"), text("owner"))
		if err != nil {
			return nil, err
		}
		type pollResult struct {
			message *scaleset.RunnerScaleSetMessage
			err     error
		}
		results := make(chan pollResult, 2)
		for range 2 {
			go func() {
				message, err := session.GetMessage(ctx, integer("lastMessageId"), integer("maxCapacity"))
				results <- pollResult{message: message, err: err}
			}()
		}
		emptyPolls := 0
		for range 2 {
			result := <-results
			if result.err != nil {
				return nil, result.err
			}
			if result.message == nil {
				emptyPolls++
			}
		}
		return map[string]any{"emptyPolls": emptyPolls}, nil
	case "deleteMessage":
		session, err := client.MessageSessionClient(ctx, integer("scaleSetId"), text("owner"))
		if err != nil {
			return nil, err
		}
		return nil, session.DeleteMessage(ctx, integer("messageId"))
	case "acquireJobs":
		session, err := client.MessageSessionClient(ctx, integer("scaleSetId"), text("owner"))
		if err != nil {
			return nil, err
		}
		ids := make([]int64, 0, len(value["requestIds"].([]any)))
		for _, id := range value["requestIds"].([]any) {
			ids = append(ids, int64(id.(float64)))
		}
		return session.AcquireJobs(ctx, ids)
	default:
		return nil, fmt.Errorf("unsupported operation %q", input.Operation)
	}
}

func next(responses []response, index *int) response {
	if *index >= len(responses) {
		return response{Status: http.StatusOK, Body: json.RawMessage(`{}`)}
	}
	result := responses[*index]
	*index++
	if result.Status == 0 {
		result.Status = http.StatusOK
	}
	return result
}

func writeJSON(w http.ResponseWriter, result response) {
	if result.Status == 0 {
		result.Status = http.StatusOK
	}
	for key, value := range result.Headers {
		w.Header().Set(key, value)
	}
	if len(result.Body) > 0 && w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(result.Status)
	if len(result.Body) > 0 {
		_, _ = w.Write(result.Body)
	}
}

func withQueueURL(result response, baseURL string) response {
	if len(result.Body) == 0 {
		return result
	}
	result.Body = json.RawMessage(strings.ReplaceAll(string(result.Body), "<queue-url>", baseURL+"/queue"))
	return result
}

func selectedHeaders(r *http.Request) map[string]string {
	result := map[string]string{}
	for _, key := range []string{"Authorization", "Content-Type", "Accept", "X-ScaleSetMaxCapacity"} {
		if value := r.Header.Get(key); value != "" {
			result[strings.ToLower(key)] = value
		}
	}
	return result
}

func canonicalBody(body string) string {
	if body == "" {
		return ""
	}
	var value any
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		return body
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return body
	}
	return strings.TrimSuffix(encoded.String(), "\n")
}

func requestTraceKey(trace requestTrace) string {
	headers, err := json.Marshal(trace.Headers)
	must(err)
	return strings.Join([]string{trace.Method, trace.Path, trace.Query, trace.Body, string(headers)}, "\x00")
}

func normalizeResult(value any) any {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var normalized any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return value
	}
	return stripGoZeroValues(normalized)
}

func stripGoZeroValues(value any) any {
	switch current := value.(type) {
	case []any:
		for i := range current {
			current[i] = stripGoZeroValues(current[i])
		}
	case map[string]any:
		for key, field := range current {
			current[key] = stripGoZeroValues(field)
		}
		if current["createdOn"] == "0001-01-01T00:00:00Z" {
			delete(current, "createdOn")
		}
		if setting, ok := current["RunnerSetting"].(map[string]any); ok && len(setting) == 0 {
			delete(current, "RunnerSetting")
		}
		if id, ok := current["runnerScaleSetId"].(float64); ok && id == 0 {
			delete(current, "runnerScaleSetId")
		}
	}
	return value
}

func messageTrace(message *scaleset.RunnerScaleSetMessage) map[string]any {
	return map[string]any{
		"messageId":    message.MessageID,
		"jobAvailable": len(message.JobAvailableMessages),
		"jobAssigned":  len(message.JobAssignedMessages),
		"jobStarted":   len(message.JobStartedMessages),
		"jobCompleted": len(message.JobCompletedMessages),
	}
}

func errorCode(err error) string {
	switch {
	case errors.Is(err, scaleset.RunnerExistsError):
		return "RUNNER_EXISTS"
	case errors.Is(err, scaleset.RunnerNotFoundError):
		return "RUNNER_NOT_FOUND"
	case errors.Is(err, scaleset.JobStillRunningError):
		return "JOB_STILL_RUNNING"
	case errors.Is(err, scaleset.MessageQueueTokenExpiredError):
		return "MESSAGE_QUEUE_TOKEN_EXPIRED"
	case errors.Is(err, scaleset.BadRequestError):
		return "BAD_REQUEST"
	case errors.Is(err, scaleset.UnauthorizedError):
		return "UNAUTHORIZED"
	case errors.Is(err, scaleset.NotFoundError):
		return "NOT_FOUND"
	case errors.Is(err, scaleset.ConflictError):
		return "CONFLICT"
	case strings.Contains(err.Error(), "invalid credentials"):
		return "VALIDATION"
	default:
		return "REQUEST_FAILED"
	}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
