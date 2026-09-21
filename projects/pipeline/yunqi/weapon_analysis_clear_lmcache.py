#!/usr/bin/env python3
# -*-coding:utf-8 -*-
import json
import uuid
import os
from yunqi_sdk import AGENT_RESULT_PATH, WeaponBase, FLAGS, MODE, runner, logger, TASK_RESULT_PATH


class WeaponAnalysis(WeaponBase):
    def is_exec_success(self):
        return os.path.exists(os.path.join(TASK_RESULT_PATH.format(task_id=self.task_id), 'result.txt'))

    def generate_result(self, exec_success=True):
        is_exec_success = 1
        result = ''
        if exec_success:
            is_exec_success = 0
            with open(os.path.join(TASK_RESULT_PATH.format(task_id=self.task_id), 'result.txt'), 'r',
                      encoding='utf-8', errors='ignore') as file:
                result = file.read()
                result = result.strip()
                result = result.replace('\n', '<n>')
        json_data = {'ids': str(uuid.uuid1()), 'graph_items': [{
            "result_item_content": [
                [],
                [],
                [],
                [
                    {"chinese_name": "命令回显", "english_name": "result", "value": f'{result}'},
                    {"chinese_name": "武器执行结果", "english_name": "is_exec_success", "value": is_exec_success}
                ]
            ],
            "result_item_num": "结果"
        }]}
        with os.fdopen(os.open(AGENT_RESULT_PATH.format(task_id=self.task_id) + '/result.json', FLAGS, MODE), 'w',
                       encoding='utf-8', errors='ignore') as file:
            file.write(json.dumps(json_data))

    def run(self):
        if self.is_exec_success():
            logger.info('生成结果信息')
            self.generate_result()
        else:
            logger.info('生成错误信息')
            self.generate_result(False)


if __name__ == '__main__':
    runner(WeaponAnalysis())
